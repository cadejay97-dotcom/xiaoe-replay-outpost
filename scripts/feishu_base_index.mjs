import './load_env.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { safeReadJson } from './lib_state.mjs';

const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const cwd = process.cwd();
const jobDir = path.resolve(cwd, getArg('--job-dir', process.env.POSTPROCESS_JOB_DIR || 'output/2026315'));
const title = getArg('--title', process.env.POSTPROCESS_TITLE || path.basename(jobDir));
const statusPath = path.join(jobDir, 'feishu_base_status.json');

function readTrim(file) {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trim();
}

function field(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function slugFromJobDir() {
  return path.basename(jobDir);
}

function buildRecord(errorText = '') {
  const docUrl = readTrim(path.join(jobDir, 'feishu_doc_url.txt'));
  const sourceUrl = readTrim(path.join(jobDir, 'source_url.txt'));
  if (!docUrl && !errorText) {
    throw new Error(`Missing feishu_doc_url.txt: ${path.join(jobDir, 'feishu_doc_url.txt')}`);
  }

  return {
    [field('FEISHU_BASE_FIELD_BROAD_ANSWER', '广泛解答')]: title,
    [field('FEISHU_BASE_FIELD_VIDEO_URL', '视频链接')]: sourceUrl,
    [field('FEISHU_BASE_FIELD_TEXT_URL', '文本链接')]: docUrl,
    [field('FEISHU_BASE_FIELD_SOURCE_ID', 'SourceID')]: slugFromJobDir()
  };
}

function writeStatus(data) {
  writeFileSync(statusPath, JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  console.log(`[feishu-base] 开始写入多维表格索引：${title}`);
  const baseToken = process.env.FEISHU_BASE_TOKEN?.trim();
  const tableId = process.env.FEISHU_BASE_TABLE_ID?.trim();
  if (!baseToken || !tableId) {
    const skipped = {
      status: 'skipped',
      reason: 'FEISHU_BASE_TOKEN 或 FEISHU_BASE_TABLE_ID 未配置，已跳过多维表格写入。',
      at: new Date().toISOString()
    };
    writeStatus(skipped);
    console.log(`[feishu-base] ${skipped.reason}`);
    return;
  }

  const record = buildRecord();
  const result = spawnSync('lark-cli', [
    'base',
    '+record-upsert',
    '--as',
    'user',
    '--base-token',
    baseToken,
    '--table-id',
    tableId,
    '--json',
    JSON.stringify(record)
  ], { encoding: 'utf8' });

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    writeStatus({
      status: 'failed',
      record,
      error: output,
      at: new Date().toISOString()
    });
    throw new Error(`lark-cli base +record-upsert failed:\n${output}`);
  }

  writeStatus({
    status: 'done',
    record,
    larkOutput: output,
    at: new Date().toISOString()
  });
  console.log(`[feishu-base] 多维表格索引写入完成：${statusPath}`);
}

main();
