const path = require('path');
const { writeFileSync, mkdirSync } = require('fs');
const { ITEM_STYPE, ITEM_RARITY } = require('./utils');

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

const ITEM = loadJson('bin/Item.json');
const LANG_ITEM = loadJson('language/zh_CN/Item.json');

/** 主流程 生成物品数据 */
function main() {
  const item = {};

  for (const id of Object.keys(ITEM)) {
    const data = ITEM[id];
    item[id] = {
      id: Number(id),
      name: LANG_ITEM[data.Title] || '',
      desc: LANG_ITEM[data.Desc] || '',
      literary: LANG_ITEM[data.Literary] || '',
      type: ITEM_STYPE[data.Stype] ?? data.Stype,
      rarity: ITEM_RARITY[data.Rarity] ?? data.Rarity ?? 0,
    };
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputFile = path.join(OUTPUT_DIR, 'item.json');
  writeFileSync(outputFile, JSON.stringify(item, null, 4), { encoding: 'utf-8' });

  console.log(`Successfully generated: ${outputFile}`);
}

main();
