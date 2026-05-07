// 第二阶段占位：不同小鹅通页面 DOM 差异较大，先保留可配置采集入口。
// 后续会从列表页读取标题和链接，写入 data/replay_queue.json，然后逐个调用 run_mvp.mjs。

import 'dotenv/config';
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const listUrl = process.env.REPLAY_LIST_URL;
const itemSelector = process.env.REPLAY_ITEM_SELECTOR || 'a';

if (!listUrl) {
  throw new Error('Missing REPLAY_LIST_URL');
}

const profileDir = path.resolve(process.cwd(), process.env.BROWSER_PROFILE_DIR || './browser-profile/xiaoe');
const browser = await chromium.launchPersistentContext(profileDir, { headless: false });
const page = browser.pages()[0] || await browser.newPage();

await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

const items = await page.locator(itemSelector).evaluateAll((nodes) => {
  return nodes
    .map((node) => ({
      title: (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' '),
      url: node.href || node.getAttribute('href') || ''
    }))
    .filter((item) => item.title && item.url);
});

mkdirSync('data', { recursive: true });
writeFileSync('data/replay_queue.json', JSON.stringify(items, null, 2), 'utf8');
console.log(`已保存 ${items.length} 条：data/replay_queue.json`);

await browser.close();
