import './load_env.mjs';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const cwd = process.cwd();
const command = process.argv[2] || 'status';
const port = Number(process.env.UI_PORT || 8787);
const runDir = path.resolve(cwd, 'data/runner');
const pidPath = path.join(runDir, 'runner.pid');
const logPath = path.resolve(cwd, 'output/ui-runner.log');

function readPid() {
  try {
    return Number(readFileSync(pidPath, 'utf8').trim());
  } catch {
    return 0;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function start() {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  const existing = readPid();
  const live = existing && isAlive(existing) ? await health() : null;
  if (live) {
    console.log(`[runner] 已在运行：http://localhost:${port} pid=${existing}`);
    return;
  }

  if (existing && !isAlive(existing)) unlinkSync(pidPath);
  const child = spawn(process.execPath, ['scripts/server.mjs'], {
    cwd,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, UI_PORT: String(port), RUNNER_LOG_PATH: logPath }
  });
  child.unref();
  writeFileSync(pidPath, String(child.pid), 'utf8');
  console.log(`[runner] 已启动：http://localhost:${port} pid=${child.pid}`);
}

async function status() {
  const pid = readPid();
  const live = pid && isAlive(pid) ? await health() : null;
  if (live) {
    console.log(JSON.stringify({ status: 'running', pid, url: `http://localhost:${port}`, health: live }, null, 2));
    return;
  }
  console.log(JSON.stringify({ status: 'stopped', pid: pid || null, url: `http://localhost:${port}` }, null, 2));
}

function stop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    console.log('[runner] 未运行');
    if (existsSync(pidPath)) unlinkSync(pidPath);
    return;
  }
  process.kill(pid, 'SIGTERM');
  unlinkSync(pidPath);
  console.log(`[runner] 已停止 pid=${pid}`);
}

if (command === 'start') await start();
else if (command === 'stop') stop();
else if (command === 'status') await status();
else {
  console.error('Usage: node scripts/runner_control.mjs start|status|stop');
  process.exitCode = 1;
}
