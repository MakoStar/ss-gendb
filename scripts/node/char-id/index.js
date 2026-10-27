const path = require('path');
const { writeFileSync, mkdirSync } = require('fs');
const { LuaFactory } = require('wasmoon');

/** 需要处理的区服代码 */
const REGION_CODES = ['CN', 'EN', 'JP', 'KR', 'TW'];

/** 角色id匹配正则 */
const CHARACTER_ID_PATTERN = /^avg1_(\d{3})$/;

/** 输出文件名 */
const OUTPUT_FILENAME = 'characterid.json';

/** 脚本所在目录 */
const SCRIPT_DIR = __dirname;

/** 输出目录 固定在脚本自身目录下 */
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'generated_data');

/** 远程lua仓库基础地址 */
const REPO_BASE = 'https://github.com/MakoStar/ss-lua/raw/refs/heads/main/';

mkdirSync(OUTPUT_DIR, { recursive: true });

/** 拼接单个区服的lua文件地址 */
function buildLuaFileUrls(regionCode) {
  const regionBase = new URL(`./Lua/Game/UI/Avg/_${regionCode.toLowerCase()}/`, REPO_BASE);
  return {
    avgCharacterUrl: new URL('./Preset/AvgCharacter.lua', regionBase),
    avgContactUrl: new URL('./Preset/AvgContacts.lua', regionBase),
  };
}

/** 拉取远程文本 失败返回null */
async function fetchLuaText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`[fetch] ${response.status} | ${response.statusText} | ${url.href}`);
    return null;
  }
  return response.text();
}

/** 在lua引擎中执行源码 失败返回null */
async function evaluateLua(lua, source) {
  try {
    return await lua.doString(source);
  } catch (error) {
    console.error(`[lua] parse error: ${error.message}`);
    return null;
  }
}

/** 解析展示名 处理占位与复用 */
function resolveDisplayName(rawName, characterId, contactsById, regionCharactersById, reuseId) {
  if (rawName !== '***') return rawName;
  const contact = contactsById.get(characterId);
  if (contact?.name) return contact.name;
  const reusedCharacter = regionCharactersById.get(String(reuseId));
  return reusedCharacter?.name ?? '';
}

/** 合并单个区服的角色与联系人数据 */
function mergeRegionCharacters(charactersById, versionsByCharId, regionKey, regionCharacters, regionContacts) {
  const contactsById = new Map(regionContacts.map((c) => [String(c.id), c]));
  const regionCharactersById = new Map(regionCharacters.map((c) => [String(c.id), c]));
  const unmatchedEntries = { ...charactersById };

  for (const { id: rawId, name: rawName, ver: rawVersion, reuse: reuseId } of regionCharacters) {
    if (typeof rawId !== 'string') continue;

    const idMatch = rawId.match(CHARACTER_ID_PATTERN);
    if (!idMatch) continue;

    const characterId = idMatch[1];
    const contact = contactsById.get(characterId);
    delete unmatchedEntries[characterId];

    const displayName = resolveDisplayName(
      rawName,
      characterId,
      contactsById,
      regionCharactersById,
      reuseId
    );

    const resolvedVersion = (rawVersion ?? contact?.ver) || '';

    if (!charactersById[characterId]) {
      charactersById[characterId] = { id: Number(characterId) };
      versionsByCharId[characterId] = new Set();
    }

    const entry = charactersById[characterId];
    entry[`${regionKey}Name`] = displayName || '';

    if (!entry.findKeys) entry.findKeys = new Set();
    if (rawId) entry.findKeys.add(rawId);
    if (reuseId) entry.findKeys.add(reuseId);

    if (resolvedVersion) {
      versionsByCharId[characterId].add(resolvedVersion);
    }
  }

  if (Object.keys(unmatchedEntries).length) {
    console.log(`[${regionKey.toUpperCase()}] unmatched`, unmatchedEntries);
    for (const [characterId, { findKeys }] of Object.entries(unmatchedEntries)) {
      for (const lookupId of findKeys) {
        const contact = contactsById.get(lookupId);
        if (contact?.name) {
          charactersById[characterId][`${regionKey}Name`] = contact.name;
          break;
        }
        const reusedCharacter = regionCharactersById.get(String(lookupId));
        if (reusedCharacter?.name) {
          charactersById[characterId][`${regionKey}Name`] = reusedCharacter.name;
          break;
        }
      }
    }
  }
}

/** 汇总版本号并写入角色条目 */
function applyVersions(charactersById, versionsByCharId) {
  for (const [characterId, versionSet] of Object.entries(versionsByCharId)) {
    const sortedVersions = [...versionSet]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    charactersById[characterId].ver =
      sortedVersions.length <= 1
        ? sortedVersions[0] ?? ''
        : sortedVersions.join(' / ');
  }
}

/** 为缺失的区服名字段补空字符串 */
function fillMissingRegionNames(charactersById) {
  const regionNameKeys = REGION_CODES.map((code) => `${code.toLowerCase()}Name`);
  for (const entry of Object.values(charactersById)) {
    for (const key of regionNameKeys) entry[key] ??= '';
  }
}

/** 主流程 遍历区服并生成结果 */
(async () => {
  if (!process.env.CI) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const charactersById = {};
  const versionsByCharId = {};

  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  try {
    for (const regionCode of REGION_CODES) {
      console.log('='.repeat(60));
      const regionKey = regionCode.toLowerCase();
      const { avgCharacterUrl, avgContactUrl } = buildLuaFileUrls(regionCode);

      console.log(`[${regionCode}] fetch lua start`);
      const [characterSource, contactSource] = await Promise.all([
        fetchLuaText(avgCharacterUrl),
        fetchLuaText(avgContactUrl),
      ]);

      if (!characterSource || !contactSource) {
        console.warn(`[${regionCode}] fetch lua failed. skipping`);
        continue;
      }

      const regionCharacters = await evaluateLua(lua, characterSource);
      const regionContacts = await evaluateLua(lua, contactSource);

      if (!Array.isArray(regionCharacters) || !Array.isArray(regionContacts)) {
        console.warn(`[${regionCode}] data is not array, skipping`);
        continue;
      }

      mergeRegionCharacters(
        charactersById,
        versionsByCharId,
        regionKey,
        regionCharacters,
        regionContacts
      );

      console.log(
        `[${regionCode}] generated characters ${Object.keys(charactersById).length}`
      );
    }

    applyVersions(charactersById, versionsByCharId);
    fillMissingRegionNames(charactersById);

    writeFileSync(
      path.join(OUTPUT_DIR, OUTPUT_FILENAME),
      JSON.stringify(
        charactersById,
        (key, value) => (key === 'findKeys' ? undefined : value),
        2
      ),
      { encoding: 'utf-8' }
    );

    console.log('='.repeat(60));
    console.log(`[done] total ${Object.keys(charactersById).length} written to ${OUTPUT_DIR}`);
  } finally {
    lua.global.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
