import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { safeReadJson, writeJson } from './lib_state.mjs';

const cwd = process.cwd();
const jobsPath = path.resolve(cwd, 'data/ui_jobs.json');
const rawPath = path.resolve(cwd, 'output/2026315/transcript_raw.md');
const activeStatuses = new Set(['running', 'postprocessing']);
const staleMs = Number(process.env.UI_STALE_JOB_MS || 10 * 60 * 1000);
const now = Date.now();

const jobs = safeReadJson(jobsPath, []);
const repaired = jobs.map((job) => {
  const updated = Date.parse(job.updatedAt || '');
  const isStale = activeStatuses.has(job.status) && Number.isFinite(updated) && now - updated > staleMs;
  if (!isStale) return job;
  return {
    ...job,
    status: 'failed',
    error: job.error || '旧任务长时间未更新，已由 repair:ui 标记为失败。',
    updatedAt: new Date().toISOString()
  };
});

writeJson(jobsPath, repaired);
console.log(`[repair-ui] 已检查 UI 任务：${jobsPath}`);

try {
  if (existsSync(rawPath) && statSync(rawPath).size === 0) {
    unlinkSync(rawPath);
    console.log(`[repair-ui] 已删除 0 字节逐字稿：${rawPath}`);
  }
} catch (error) {
  console.warn(`[repair-ui] 清理 0 字节逐字稿失败：${error.message}`);
}
