const path = require('path');
const fs = require('fs/promises');
const { createEnv } = require('lua-in-js');
const { writeFileSync, mkdirSync } = require('fs');

/** 仓库根目录 脚本处于三级子目录中 */
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

/** 数据目录 优先用环境变量 否则回退仓库内数据文件夹 */
const DATA_DIR = process.env.SS_DATA_DIR
  ? path.resolve(process.env.SS_DATA_DIR)
  : path.join(ROOT_DIR, 'ss-data');

/** 输出目录 固定在脚本自身目录下 */
const OUTPUT_DIR = path.join(__dirname, 'generated_data');

/** 表定义远程地址 */
const GAME_TABLE_DEFINE_URL =
  'https://github.com/MakoStar/ss-lua/raw/refs/heads/main/Lua/Game/CodeGen/GAME_TABLE_DEFINE.lua';

/** 递归收集目录下符合条件的文件 */
async function collectFiles(dir, filter) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  const tasks = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      tasks.push(collectFiles(fullPath, filter));
    } else if (entry.isFile() && filter(fullPath)) {
      files.push(fullPath);
    }
  }

  const subResults = await Promise.all(tasks);
  return files.concat(...subResults);
}

/** 读取并解析单个文件 返回相对路径与内容 */
async function readAndParse(filePath, basePath, encoding, strictJson) {
  const relativePath = path.relative(basePath, filePath).replace(/\\/g, '/');

  try {
    const data = await fs.readFile(filePath, encoding);

    if (relativePath.endsWith('.json')) {
      try {
        return [relativePath, JSON.parse(data)];
      } catch (e) {
        console.error(`JSON parse failed: ${relativePath}`, e.message);
        if (!strictJson) return [relativePath, data];
        return null;
      }
    }

    return [relativePath, data];
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err.message);
    return null;
  }
}

/** 并发消费任务队列 */
async function runWorkerPool(tasks, concurrency, workerFn) {
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex++];
      await workerFn(task);
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );

  await Promise.all(workers);
}

/** 扫描目录 并发读取并解析为路径到内容的映射 */
async function buildDataFileMap(dirPath, options = {}) {
  const {
    concurrency = 20,
    filter = () => true,
    encoding = 'utf-8',
    basePath = dirPath,
    strictJson = false,
  } = options;

  const map = new Map();
  const files = await collectFiles(dirPath, filter);

  const processTask = async (filePath) => {
    const result = await readAndParse(filePath, basePath, encoding, strictJson);
    if (result) {
      map.set(result[0], result[1]);
    }
  };

  await runWorkerPool(files, concurrency, processTask);
  return map;
}

/** 将lua表结构递归转为普通js对象 */
function luaTableToJS(table) {
  if (!table || typeof table !== 'object' || !table.strValues) {
    return table;
  }

  const result = {};

  for (const [key, value] of Object.entries(table.strValues)) {
    result[key] = luaTableToJS(value);
  }

  if (table.numValues && table.numValues.length > 0) {
    const arr = [];

    for (let i = 0; i < table.numValues.length; i++) {
      const val = table.numValues[i];
      if (val !== undefined) {
        arr[i] = luaTableToJS(val);
      }
    }

    if (Object.keys(result).length === 0) {
      return arr.filter((v) => v !== undefined);
    } else {
      arr.forEach((v, i) => {
        if (v !== undefined) result[String(i + 1)] = v;
      });
    }
  }

  return result;
}

/** 拉取并解析表定义 返回通用表配置 */
async function getTableDefine(tableDefineUrl) {
  const response = await fetch(tableDefineUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${tableDefineUrl}`);
  }

  const luaTableDefineCode = await response.text();

  let tableDefineData;
  try {
    tableDefineData = createEnv().parse(luaTableDefineCode).exec();
  } catch (e) {
    throw new Error(`Lua parse error: ${e.message}`);
  }

  const { CommonTable } = luaTableToJS(tableDefineData);
  if (!CommonTable) {
    throw new Error('CommonTable not found in parsed Lua data');
  }

  return CommonTable;
}

/** 区服与语言地区映射 */
const REGION_CONFIGS = [
  { key: 'CN', value: 'zh_CN' },
  { key: 'EN', value: 'en_US' },
  { key: 'JP', value: 'ja_JP' },
  { key: 'KR', value: 'ko_KR' },
  { key: 'TW', value: 'zh_TW' },
];

/** 主流程 遍历区服生成多语言对照表 */
(async () => {
  const jsonDataMapping = await buildDataFileMap(DATA_DIR, {
    filter: (fp) => fp.endsWith('.json'),
    encoding: 'utf-8',
    concurrency: 30,
  });

  const tableDefineData = await getTableDefine(GAME_TABLE_DEFINE_URL);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const region of REGION_CONFIGS) {
    console.log(`Generating language.${region.value}.json`);
    const languageJson = {};

    for (const [tableKey, tableValue] of Object.entries(tableDefineData)) {
      const { Key, Lang } = tableValue ?? {};
      if (!(Key && Array.isArray(Lang))) continue;

      const binPath = `${region.key}/bin/${tableKey}.json`;
      const lanPath = `${region.key}/language/${region.value}/${tableKey}.json`;

      const binData = jsonDataMapping.get(binPath);
      const lanData = jsonDataMapping.get(lanPath);

      if (!binData || !lanData) continue;

      const lanKeySet = new Set(Object.keys(lanData));

      for (const langItem of Lang) {
        for (const binItem of Object.values(binData)) {
          const lqaKey = binItem[langItem];
          if (!lqaKey || !lanKeySet.has(lqaKey)) continue;
          languageJson[lqaKey] = lanData[lqaKey];
        }
      }
    }

    const filePath = path.join(OUTPUT_DIR, `language.${region.value}.json`);
    writeFileSync(filePath, JSON.stringify(languageJson, null, 4), { encoding: 'utf-8' });
    console.log(`Saved ${filePath}`);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
