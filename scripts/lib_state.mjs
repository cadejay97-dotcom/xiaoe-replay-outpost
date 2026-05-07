import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function safeReadJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const text = readFileSync(file, 'utf8').trim();
    if (!text) return fallback;
    return JSON.parse(text);
  } catch (error) {
    console.warn(`[state] JSON 读取失败，使用兜底值：${file}`);
    console.warn(`[state] ${error.code || error.name}: ${error.message}`);
    return fallback;
  }
}

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function readTextIfExists(file, fallback = '') {
  try {
    if (!existsSync(file)) return fallback;
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export function nowLocalText() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds())
  ].join('');
}
