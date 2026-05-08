import './load_env.mjs';
import { createServer } from 'node:http';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { readTextIfExists, safeReadJson, writeJson } from './lib_state.mjs';

const cwd = process.cwd();
const port = Number(process.env.UI_PORT || 8787);
const jobsPath = path.resolve(cwd, 'data/ui_jobs.json');
const processedPath = path.resolve(cwd, 'data/processed.json');
const failedPath = path.resolve(cwd, 'data/failed_jobs.json');
const publicDir = path.resolve(cwd, 'public');
const logDir = path.resolve(cwd, 'output/ui-logs');
const runnerLogPath = process.env.RUNNER_LOG_PATH?.trim();
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

function runnerLog(message) {
  const line = `[runner] ${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  if (runnerLogPath) {
    try {
      mkdirSync(path.dirname(runnerLogPath), { recursive: true });
      appendFileSync(runnerLogPath, line, 'utf8');
    } catch {}
  }
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
  const outputJobs = process.env.UI_SCAN_OUTPUT === '1' ? scanOutputJobs() : [];
  return mergeJobs(jobs, processed, failed, outputJobs).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function inferPhase(job) {
  if (job.status === 'done') return 'done';
  if (job.status === 'failed') return 'failed';
  const logPath = job.logPath;
  if (!logPath || !existsSync(logPath)) return job.status === 'postprocessing' ? 'transcribing' : job.status;
  const log = readTail(logPath, 16000);
  if (/飞书写入完成|飞书文档链接已保存|多维表格索引写入完成|写入 processed\.json/.test(log)) return 'feishu';
  if (/写入飞书|创建飞书文档|开始写入飞书|feishu-base/.test(log)) return 'feishu';
  if (/清洗完成|transcript_clean\.md 应已生成/.test(log)) return 'cleaned';
  if (/清洗逐字稿|开始清洗/.test(log)) return 'cleaning';
  if (/转写完成|transcript_raw\.md 应已生成/.test(log)) return 'transcribed';
  if (/开始本地转写|开始 OpenAI Whisper API 转写|开始火山 ASR 转写|转写已有录音/.test(log)) return 'transcribing';
  if (/录音结束|wav 已生成|recording\.wav/.test(log)) return 'recorded';
  if (/开始录音|启动录音|秒后开始录音/.test(log)) return 'recording';
  if (/已请求系统 Chrome 打开|打开 Chrome|正在打开 REPLAY_URL|页面加载完成/.test(log)) return 'opening';
  return job.status;
}

function readTail(file, maxBytes = 16000) {
  let fd;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
      status: item.status || 'done',
      phase: item.status || 'done',
      feishuDocUrl: item.feishuDocUrl || readTextIfExists(path.join(item.jobDir || '', 'feishu_doc_url.txt')).trim(),
      feishuBaseStatus: item.feishuBaseStatus || '',
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
      const baseStatus = safeReadJson(path.join(dir, 'feishu_base_status.json'), {});
      const jobState = safeReadJson(path.join(dir, 'job_state.json'), {});
      const docUrl = readTextIfExists(path.join(dir, 'feishu_doc_url.txt')).trim();
      const cleanExists = hasContent(path.join(dir, 'transcript_clean.md'));
      const rawExists = hasContent(path.join(dir, 'transcript_raw.md'));
      const recordingExists = existsSync(path.join(dir, 'recording.wav'));
      const status = docUrl && baseStatus.status === 'failed'
        ? 'base_failed'
        : docUrl ? 'done' : cleanExists ? 'cleaned' : rawExists ? 'transcribed' : recordingExists ? 'recorded' : 'created';
      const phase = jobState.phase || status;
      return {
        id: path.basename(dir),
        title: path.basename(dir),
        jobDir: dir,
        replayUrl: readTextIfExists(path.join(dir, 'source_url.txt')).trim(),
        status,
        phase,
        jobState,
        feishuDocUrl: docUrl,
        feishuBaseStatus: baseStatus.status || '',
        feishuBaseError: baseStatus.error || '',
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

function enrichJob(job) {
  const phase = inferPhase(job);
  return { ...job, phase };
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
    const failureText = done ? '' : summarizeFailure(logPath, command, code);
    saveUiJob({
      ...current,
      status: done ? 'done' : 'failed',
      phase: done ? 'done' : 'failed',
      error: failureText,
      logPath,
      updatedAt: new Date().toISOString()
    });
  });
  return child;
}

function summarizeFailure(logPath, command, code) {
  const tail = readTail(logPath, 12000).split(/\r?\n/).filter(Boolean).slice(-18).join('\n');

  const lower = tail.toLowerCase();
  let hint = '';
  if (/keychain not initialized/.test(lower)) {
    hint = '飞书 CLI 无法读取本机 keychain。请在普通 Terminal 里运行 npm run feishu:check。';
  } else if (/scope|permission|missing required scope/.test(lower)) {
    hint = '飞书 CLI 权限不足。请运行 npm run feishu:check 并按提示补授权。';
  } else if (/is_probably_silent|录音可能是静音|blackhole/.test(lower)) {
    hint = '录音可能是静音。请检查系统输出是否为多输出设备，且包含 BlackHole 2ch。';
  } else if (/missing recording\.wav/.test(lower)) {
    hint = '没有找到 recording.wav，请先完成一次录音或选择正确输出目录。';
  }

  return [
    hint || `${command} exited with code ${code}.`,
    `日志：${logPath}`,
    tail ? `\n最近日志：\n${tail}` : ''
  ].join('\n').trim();
}

function checkFeishu() {
  const result = spawnSync('npm', ['run', 'feishu:check'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: Number(process.env.FEISHU_CHECK_TIMEOUT_MS || 8000)
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  let status = 'connected';
  let label = '飞书已连接';
  if (result.error?.code === 'ETIMEDOUT') {
    status = 'timeout';
    label = '飞书检查超时';
  } else if (result.status !== 0) {
    if (/keychain not initialized/i.test(output)) {
      status = 'keychain';
      label = 'Keychain 不可用';
    } else if (/需要补充授权|missing|required scope|auth login/i.test(output)) {
      status = 'unauthorized';
      label = '飞书未授权';
    } else {
      status = 'error';
      label = '飞书检查失败';
    }
  }
  return {
    ok: result.status === 0,
    status,
    label,
    output,
    checkedAt: new Date().toISOString()
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      service: 'xiaoe-replay-outpost-runner',
      pid: process.pid,
      port,
      cwd,
      uptimeSeconds: Math.round(process.uptime()),
      running: [...running.keys()],
      checkedAt: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    return json(res, 200, { jobs: allJobs().map(enrichJob), running: [...running.keys()] });
  }

  if (req.method === 'GET' && pathname === '/api/feishu/check') {
    return json(res, 200, checkFeishu());
  }

  if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
    const id = decodeURIComponent(pathname.split('/').pop());
    const job = allJobs().map(enrichJob).find((item) => item.id === id);
    return job ? json(res, 200, { job }) : json(res, 404, { error: 'job not found' });
  }

  if (req.method === 'POST' && pathname === '/api/run') {
    const body = await readBody(req);
    if (hasActiveJob()) return json(res, 409, { error: '已有任务正在运行，请等当前任务结束后再开始。' });
    const replayUrl = String(body.replayUrl || '').trim();
    const manualTitle = String(body.title || '').trim();
    if (!replayUrl) return json(res, 400, { error: 'replayUrl is required' });
    const id = `run-${Date.now()}`;
    const job = {
      id,
      title: manualTitle || '新采集任务',
      replayUrl,
      status: 'running',
      phase: 'opening',
      updatedAt: new Date().toISOString()
    };
    spawnJob(job, 'npm', ['run', 'run:mvp'], {
      REPLAY_URL: replayUrl,
      RECORD_SECONDS: String(Number(body.recordSeconds || process.env.RECORD_SECONDS || 14400)),
      RECORD_MODE: body.recordMode || process.env.RECORD_MODE || 'complete',
      FORCE_RERUN: body.forceRerun === false ? '0' : '1',
      AUDIO_DEVICE_NAME: body.audioDeviceName || process.env.AUDIO_DEVICE_NAME || 'BlackHole 2ch',
      BROWSER_EXECUTABLE_PATH: body.browserExecutablePath || process.env.BROWSER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      BROWSER_DRIVER: body.browserDriver || process.env.UI_BROWSER_DRIVER || 'playwright',
      MANUAL_START_DELAY_SECONDS: String(Number(body.manualStartDelaySeconds || process.env.MANUAL_START_DELAY_SECONDS || 20)),
      MANUAL_TITLE: manualTitle || process.env.MANUAL_TITLE || '小鹅通回放手动采集',
      PLAYWRIGHT_IMPORT_TIMEOUT_MS: process.env.PLAYWRIGHT_IMPORT_TIMEOUT_MS || '120000',
      DEBUG_BROWSER_TIMEOUT_MS: process.env.DEBUG_BROWSER_TIMEOUT_MS || '120000'
    });
    return json(res, 202, { job });
  }

  if (req.method === 'POST' && pathname === '/api/feishu/retry-base') {
    const body = await readBody(req);
    if (hasActiveJob()) return json(res, 409, { error: '已有任务正在运行，请等当前任务结束后再重试。' });
    const jobDir = String(body.jobDir || '').trim();
    if (!jobDir) return json(res, 400, { error: 'jobDir is required' });
    const resolvedJobDir = path.resolve(cwd, jobDir);
    const title = String(body.title || path.basename(resolvedJobDir)).trim();
    const id = `retry-base-${Date.now()}`;
    const job = {
      id,
      title,
      jobDir: resolvedJobDir,
      status: 'postprocessing',
      phase: 'feishu',
      updatedAt: new Date().toISOString()
    };
    spawnJob(job, 'node', ['scripts/feishu_base_index.mjs', '--job-dir', resolvedJobDir, '--title', title], {});
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
      phase: 'transcribing',
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
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
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

server.requestTimeout = Number(process.env.UI_REQUEST_TIMEOUT_MS || 30000);
server.headersTimeout = Number(process.env.UI_HEADERS_TIMEOUT_MS || 35000);

server.on('error', (error) => {
  console.error(`[ui] 本地服务启动失败：${error.code || error.name} ${error.message}`);
  console.error('[ui] 如果这是 Codex 沙箱里的 EPERM，请在 macOS Terminal 里运行：npm run serve');
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  runnerLog(`前哨站采集台已启动：http://localhost:${port}`);
});
