const path = require('path');
const { writeFileSync, mkdirSync } = require('fs');

/** 仓库根目录 脚本处于三级子目录中 */
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

/** 数据目录 优先用环境变量 否则回退仓库内数据文件夹 */
const DATA_DIR = process.env.SS_DATA_DIR
  ? path.resolve(process.env.SS_DATA_DIR)
  : path.join(ROOT_DIR, 'ss-data');

/** 仅使用国服数据 */
const REGION_DIR = path.join(DATA_DIR, 'CN');

/** 输出目录 固定在脚本自身目录下 */
const OUTPUT_DIR = path.join(__dirname, 'generated_data');

/** 读取单个json文件 */
function loadJson(file) {
  return require(path.join(REGION_DIR, file));
}

const GACHA = loadJson('bin/Gacha.json');
const GACHAPKG = loadJson('bin/GachaPkg.json');
const CHARACTER = loadJson('bin/Character.json');
const DISC = loadJson('bin/Disc.json');
const ITEM = loadJson('bin/Item.json');
const LANG_GACHA = loadJson('language/zh_CN/Gacha.json');
const LANG_CHARACTER = loadJson('language/zh_CN/Character.json');
const LANG_ITEM = loadJson('language/zh_CN/Item.json');
const LANG_UITEXT = loadJson('language/zh_CN/UIText.json');

/** 按pkgId预建索引 避免每次线性扫描整个表 */
const GACHA_PKG_BY_ID = new Map();
for (const [key, value] of Object.entries(GACHAPKG)) {
  const list = GACHA_PKG_BY_ID.get(value.PkgId) || [];
  list.push({ key, goodsId: value.GoodsId });
  GACHA_PKG_BY_ID.set(value.PkgId, list);
}

/** 解析单个卡池的up内容 */
function getGachaPkg(pkgId) {
  const entries = GACHA_PKG_BY_ID.get(pkgId);
  if (!entries) return [];

  return entries.map(({ goodsId: id }) => ({
    id,
    name: LANG_CHARACTER[CHARACTER[id]?.Name] || LANG_ITEM[ITEM[id]?.Title],
    element:
      LANG_UITEXT[`UIText.T_Element_Attr_${CHARACTER[id]?.EET}.1`] ||
      LANG_UITEXT[`UIText.T_Element_Attr_${DISC[id]?.EET}.1`],
  }));
}

/** 主流程 生成卡池数据 */
function main() {
  const gacha = {};

  for (const id of Object.keys(GACHA)) {
    if (Number(id) < 10000) continue;

    gacha[id] = {
      id: Number(id),
      type: GACHA[id].StorageId === 1 ? 'character' : 'disc',
      name: LANG_GACHA[GACHA[id].Name],
      icon: GACHA[id].Icon.split('/').pop(),
      rateUp5Star: getGachaPkg(GACHA[id].ATypeUpPkg),
      rateUp4Star: getGachaPkg(GACHA[id].BTypeUpPkg),
      startTime: GACHA[id].StartTime,
      endTime: GACHA[id].EndTime,
    };
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputFile = path.join(OUTPUT_DIR, 'gacha.json');
  writeFileSync(outputFile, JSON.stringify(gacha, null, 4), { encoding: 'utf-8' });

  console.log(`Successfully generated: ${outputFile}`);
}

main();
