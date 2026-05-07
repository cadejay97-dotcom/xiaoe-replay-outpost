import './load_env.mjs';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readTextIfExists, safeReadJson, writeJson } from './lib_state.mjs';

const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const cwd = process.cwd();
const jobDir = path.resolve(cwd, getArg('--job-dir', process.env.POSTPROCESS_JOB_DIR || 'output/2026315'));
const title = getArg('--title', process.env.POSTPROCESS_TITLE || '2026.3.15 新时代视角下的"执行力"新解…');
const replayUrl = getArg('--url', readTextIfExists(path.join(jobDir, 'source_url.txt')).trim());
const pythonBin = process.env.PYTHON_BIN || (existsSync(path.resolve(cwd, '.venv/bin/python')) ? path.resolve(cwd, '.venv/bin/python') : 'python3');
const processedPath = path.resolve(cwd, 'data/processed.json');
const failedPath = path.resolve(cwd, 'data/failed_jobs.json');

function hasContent(file) {
  try {
    return existsSync(file) && statSync(file).size > 20;
  } catch {
    return false;
  }
}

function runStep(name, command, stepArgs, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[postprocess] ${name}：开始`);
    const child = spawn(command, stepArgs, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        POSTPROCESS_JOB_DIR: jobDir,
        POSTPROCESS_TITLE: title
      },
      ...options
    });
    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`[postprocess] ${name}：完成`);
        resolve();
      } else {
        reject(new Error(`${name} failed: ${command} exited with code ${code}`));
      }
    });
  });
}

function markProcessed(docUrl = '') {
  const processed = safeReadJson(processedPath, {});
  processed[replayUrl || jobDir] = {
    status: 'done',
    title,
    jobDir,
    replayUrl,
    feishuDocUrl: docUrl,
    finishedAt: new Date().toISOString()
  };
  writeJson(processedPath, processed);
  console.log(`[postprocess] 写入 processed.json：${processedPath}`);
}

function markFailed(error) {
  const failed = safeReadJson(failedPath, []);
  failed.push({
    url: replayUrl,
    title,
    jobDir,
    error: error.message,
    failedAt: new Date().toISOString()
  });
  writeJson(failedPath, failed);
  console.log(`[postprocess] 写入 failed_jobs.json：${failedPath}`);
}

async function main() {
  mkdirSync(path.dirname(processedPath), { recursive: true });
  if (!existsSync(path.join(jobDir, 'recording.wav'))) {
    throw new Error(`Missing recording.wav: ${path.join(jobDir, 'recording.wav')}`);
  }

  if (!hasContent(path.join(jobDir, 'transcript_raw.md')) || process.env.FORCE_TRANSCRIBE === '1') {
    await runStep('转写已有录音', pythonBin, ['py/transcribe_existing.py', '--job-dir', jobDir]);
  } else {
    console.log('[postprocess] transcript_raw.md 已存在，跳过转写。设置 FORCE_TRANSCRIBE=1 可重转写。');
  }

  if (!hasContent(path.join(jobDir, 'transcript_clean.md')) || process.env.FORCE_CLEAN === '1') {
    await runStep('清洗逐字稿', 'node', ['scripts/clean_transcript.mjs', '--job-dir', jobDir, '--title', title]);
  } else {
    console.log('[postprocess] transcript_clean.md 已存在，跳过清洗。设置 FORCE_CLEAN=1 可重清洗。');
  }

  await runStep('创建飞书文档', 'node', ['scripts/feishu_doc.mjs', '--job-dir', jobDir, '--title', title]);
  const docUrl = readTextIfExists(path.join(jobDir, 'feishu_doc_url.txt')).trim();

  try {
    await runStep('写入飞书多维表格索引', 'node', ['scripts/feishu_base_index.mjs', '--job-dir', jobDir, '--title', title]);
  } catch (error) {
    console.warn(`[postprocess] 飞书多维表格索引写入失败，但文档链接已保留：${error.message}`);
  }

  markProcessed(docUrl);
}

main().catch((error) => {
  console.error('[postprocess:error]', error);
  markFailed(error);
  process.exitCode = 1;
});
