import './load_env.mjs';
import { createServer } from 'node:http';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readTextIfExists, safeReadJson, writeJson } from './lib_state.mjs';

const cwd = process.cwd();
const port = Number(process.env.UI_PORT || 8787);
const jobsPath = path.resolve(cwd, 'data/ui_jobs.json');
const processedPath = path.resolve(cwd, 'data/processed.json');
const failedPath = path.resolve(cwd, 'data/failed_jobs.json');
const publicDir = path.resolve(cwd, 'public');
const logDir = path.resolve(cwd, 'output/ui-logs');
const running = new Map();
const activeStatuses = new Set(['running', 'postprocessing']);

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function allJobs() {
  const jobs = normalizeUiJobs(safeReadJson(jobsPath, []));
  const processed = safeReadJson(processedPath, {});
  const failed = safeReadJson(failedPath, []);
  const outputJobs = scanOutputJobs();
  return mergeJobs(jobs, processed, failed, outputJobs).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function normalizeUiJobs(jobs) {
  const staleMs = Number(process.env.UI_STALE_JOB_MS || 20 * 60 * 1000);
  const now = Date.now();
  return jobs.map((job) => {
    if (!activeStatuses.has(job.status) || running.has(job.id)) return job;
    const updated = Date.parse(job.updatedAt || '');
    if (Number.isFinite(updated) && now - updated > staleMs) {
      return {
        ...job,
        status: 'failed',
        error: job.error || '任务长时间未更新，已标记为失败。可重新点击处理。',
        updatedAt: new Date().toISOString()
      };
    }
    return job;
  });
}

function mergeJobs(jobs, processed, failed, outputJobs) {
  const map = new Map();
  for (const job of outputJobs) map.set(job.id, job);
  for (const job of jobs) map.set(job.id, { ...(map.get(job.id) || {}), ...job });
  for (const [url, item] of Object.entries(processed || {})) {
    const id = item.jobDir ? path.basename(item.jobDir) : url;
    map.set(id, {
      ...(map.get(id) || {}),
      id,
      title: item.title || id,
      replayUrl: item.replayUrl || url,
      jobDir: item.jobDir || '',
      status: 'done',
      feishuDocUrl: item.feishuDocUrl || readTextIfExists(path.join(item.jobDir || '', 'feishu_doc_url.txt')).trim(),
      updatedAt: item.finishedAt || new Date().toISOString()
    });
  }
  for (const item of failed || []) {
    const id = item.jobDir ? path.basename(item.jobDir) : `failed-${item.failedAt || Date.now()}`;
    map.set(id, {
      ...(map.get(id) || {}),
      id,
      title: item.title || id,
      replayUrl: item.url || '',
      jobDir: item.jobDir || '',
      status: 'failed',
      error: item.error || '',
      updatedAt: item.failedAt || new Date().toISOString()
    });
  }
  return [...map.values()];
}

function scanOutputJobs() {
  const outputDir = path.resolve(cwd, 'output');
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .map((name) => path.join(outputDir, name))
    .filter((file) => {
      try {
        return statSync(file).isDirectory();
      } catch {
        return false;
      }
    })
    .map((dir) => {
      const audioReport = safeReadJson(path.join(dir, 'audio_report.json'), {});
      const docUrl = readTextIfExists(path.join(dir, 'feishu_doc_url.txt')).trim();
      const cleanExists = hasContent(path.join(dir, 'transcript_clean.md'));
      const rawExists = hasContent(path.join(dir, 'transcript_raw.md'));
      const recordingExists = existsSync(path.join(dir, 'recording.wav'));
      return {
        id: path.basename(dir),
        title: path.basename(dir),
        jobDir: dir,
        replayUrl: readTextIfExists(path.join(dir, 'source_url.txt')).trim(),
        status: docUrl ? 'done' : cleanExists ? 'cleaned' : rawExists ? 'transcribed' : recordingExists ? 'recorded' : 'created',
        feishuDocUrl: docUrl,
        isSilent: audioReport.is_probably_silent,
        duration: audioReport.duration_seconds,
        updatedAt: fileMtimeIso(dir)
      };
    });
}

function hasContent(file) {
  try {
    return existsSync(file) && statSync(file).size > 20;
  } catch {
    return false;
  }
}

function fileMtimeIso(file) {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function saveUiJob(job) {
  const jobs = safeReadJson(jobsPath, []);
  const index = jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) jobs[index] = { ...jobs[index], ...job };
  else jobs.push(job);
  writeJson(jobsPath, jobs);
}

function hasActiveJob() {
  return allJobs().some((job) => activeStatuses.has(job.status));
}

function spawnJob(job, command, args, env) {
  saveUiJob(job);
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${job.id}.log`);
  appendFileSync(logPath, `[ui] ${new Date().toISOString()} ${command} ${args.join(' ')}\n`, 'utf8');
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  });
  saveUiJob({ ...job, logPath });
  running.set(job.id, child);
  child.stdout.on('data', (chunk) => {
    appendFileSync(logPath, chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    appendFileSync(logPath, chunk);
    process.stderr.write(chunk);
  });
  child.on('exit', (code) => {
    running.delete(job.id);
    const current = safeReadJson(jobsPath, []).find((item) => item.id === job.id) || job;
    const done = code === 0;
    saveUiJob({
      ...current,
      status: done ? 'done' : 'failed',
      error: done ? '' : `${command} exited with code ${code}. 详情见 ${logPath}`,
      logPath,
      updatedAt: new Date().toISOString()
    });
  });
  return child;
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/jobs') {
    return json(res, 200, { jobs: allJobs(), running: [...running.keys()] });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
    const id = decodeURIComponent(pathname.split('/').pop());
    const job = allJobs().find((item) => item.id === id);
    return job ? json(res, 200, { job }) : json(res, 404, { error: 'job not found' });
  }

  if (req.method === 'POST' && pathname === '/api/run') {
    const body = await readBody(req);
    if (hasActiveJob()) return json(res, 409, { error: '已有任务正在运行，请等当前任务结束后再开始。' });
    const replayUrl = String(body.replayUrl || '').trim();
    if (!replayUrl) return json(res, 400, { error: 'replayUrl is required' });
    const id = `run-${Date.now()}`;
    const job = {
      id,
      title: '新采集任务',
      replayUrl,
      status: 'running',
      updatedAt: new Date().toISOString()
    };
    spawnJob(job, 'npm', ['run', 'run:mvp'], {
      REPLAY_URL: replayUrl,
      RECORD_SECONDS: String(Number(body.recordSeconds || process.env.RECORD_SECONDS || 60)),
      FORCE_RERUN: body.forceRerun === false ? '0' : '1',
      AUDIO_DEVICE_NAME: body.audioDeviceName || process.env.AUDIO_DEVICE_NAME || 'BlackHole 2ch',
      BROWSER_EXECUTABLE_PATH: body.browserExecutablePath || process.env.BROWSER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      BROWSER_DRIVER: body.browserDriver || process.env.BROWSER_DRIVER || 'open-chrome',
      MANUAL_START_DELAY_SECONDS: String(Number(body.manualStartDelaySeconds || process.env.MANUAL_START_DELAY_SECONDS || 20)),
      PLAYWRIGHT_IMPORT_TIMEOUT_MS: process.env.PLAYWRIGHT_IMPORT_TIMEOUT_MS || '120000',
      DEBUG_BROWSER_TIMEOUT_MS: process.env.DEBUG_BROWSER_TIMEOUT_MS || '120000'
    });
    return json(res, 202, { job });
  }

  if (req.method === 'POST' && pathname === '/api/postprocess') {
    const body = await readBody(req);
    if (hasActiveJob()) return json(res, 409, { error: '已有任务正在运行，请等当前任务结束后再处理。' });
    const jobDir = String(body.jobDir || 'output/2026315').trim();
    const title = String(body.title || process.env.POSTPROCESS_TITLE || '2026.3.15 新时代视角下的"执行力"新解…').trim();
    const id = `postprocess-${Date.now()}`;
    const job = {
      id,
      title,
      jobDir: path.resolve(cwd, jobDir),
      status: 'postprocessing',
      updatedAt: new Date().toISOString()
    };
    spawnJob(job, 'node', ['scripts/postprocess_existing.mjs', '--job-dir', jobDir, '--title', title], {});
    return json(res, 202, { job });
  }

  return json(res, 404, { error: 'api not found' });
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(publicDir, `.${target}`);
  if (!file.startsWith(publicDir) || !existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(file);
  const type = ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'content-type': type });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.on('error', (error) => {
  console.error(`[ui] 本地服务启动失败：${error.code || error.name} ${error.message}`);
  console.error('[ui] 如果这是 Codex 沙箱里的 EPERM，请在 macOS Terminal 里运行：npm run serve');
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[ui] 前哨站采集台已启动：http://localhost:${port}`);
});
