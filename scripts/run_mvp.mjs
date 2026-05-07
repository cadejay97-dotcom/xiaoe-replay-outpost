console.log('[boot:first-line] run_mvp.mjs started');
console.log('[boot:env] loading env...');
console.log('[boot:cwd]', process.cwd());
console.log('[boot:node]', process.version);

process.on('unhandledRejection', (error) => {
  console.error('[boot:unhandledRejection]', error);
});
process.on('uncaughtException', (error) => {
  console.error('[boot:uncaughtException]', error);
  process.exitCode = 1;
});

console.log('[boot:import] loading node builtins...');
const { spawn } = await import('node:child_process');
const { createRequire } = await import('node:module');
const { createInterface } = await import('node:readline/promises');
const { stdin: input, stdout: output } = await import('node:process');
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
const path = (await import('node:path')).default;
const { safeReadJson } = await import('./lib_state.mjs');
const require = createRequire(import.meta.url);
console.log('[boot:import] node builtins loaded');

console.log('[boot:env] reading .env file...');
const envPath = path.resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  console.log('[boot:env] .env loaded:', envPath);
} else {
  console.log('[boot:env] .env not found, using process env only');
}

const cwd = process.cwd();
const replayUrl = process.env.REPLAY_URL;
const tempProfile = process.env.TEMP_PROFILE === '1' || process.env.TEMP_PROFILE === 'true';
const resetProfile = process.env.RESET_PROFILE === '1' || process.env.RESET_PROFILE === 'true';
const profileDir = tempProfile
  ? path.resolve('/tmp', `xiaoe-playwright-profile-${Date.now()}`)
  : path.resolve(cwd, process.env.BROWSER_PROFILE_DIR || './browser-profile/xiaoe');
const outputDir = path.resolve(cwd, process.env.OUTPUT_DIR || './output');
const recordSeconds = Number(process.env.RECORD_SECONDS || 5400);
const processedPath = path.resolve(cwd, './data/processed.json');
const failedPath = path.resolve(cwd, './data/failed_jobs.json');
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const forceRerun = process.env.FORCE_RERUN === '1' || process.env.FORCE_RERUN === 'true';
const debugStartup = process.env.DEBUG_STARTUP === '1' || process.env.DEBUG_STARTUP === 'true';
const debugBrowser = process.env.DEBUG_BROWSER === '1' || process.env.DEBUG_BROWSER === 'true';
const browserDriver = process.env.BROWSER_DRIVER || 'playwright';
const manualStartDelaySeconds = Number(process.env.MANUAL_START_DELAY_SECONDS || 20);
const pythonBin = process.env.PYTHON_BIN || (existsSync(path.resolve(cwd, '.venv/bin/python')) ? path.resolve(cwd, '.venv/bin/python') : 'python3');
const consoleLines = [];

let chromium = null;
let slugify = null;

if (!debugStartup && !debugBrowser && !replayUrl) {
  throw new Error('Missing REPLAY_URL. Example: REPLAY_URL="https://..." npm run run:mvp');
}

function log(message, data = undefined) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (data !== undefined) console.log(data);
}

function readJson(file, fallback) {
  return safeReadJson(file, fallback);
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function readInstalledVersion(packageName) {
  try {
    const packageJsonPath = path.resolve(cwd, 'node_modules', packageName, 'package.json');
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
  } catch {
    return 'not-installed';
  }
}

function playwrightVersions() {
  return {
    playwright: readInstalledVersion('playwright'),
    '@playwright/test': readInstalledVersion('@playwright/test'),
    'playwright-core': readInstalledVersion('playwright-core')
  };
}

function printStartupDiagnostics(processed) {
  const processedRecord = processed[replayUrl];
  log('启动诊断：');
  console.log(JSON.stringify({
    cwd,
    REPLAY_URL: replayUrl,
    RECORD_SECONDS: recordSeconds,
    AUDIO_DEVICE_NAME: process.env.AUDIO_DEVICE_NAME || 'BlackHole 2ch',
    AUDIO_DEVICE_INDEX: process.env.AUDIO_DEVICE_INDEX || '',
    DRY_RUN: dryRun,
    FORCE_RERUN: forceRerun,
    DEBUG_STARTUP: debugStartup,
    DEBUG_BROWSER: debugBrowser,
    BROWSER_DRIVER: browserDriver,
    MANUAL_START_DELAY_SECONDS: manualStartDelaySeconds,
    TEMP_PROFILE: tempProfile,
    RESET_PROFILE: resetProfile,
    browserHeadless: false,
    playwrightVersions: playwrightVersions(),
    userDataDir: profileDir,
    outputDir,
    processedPath,
    processedJsonExists: existsSync(processedPath),
    replayUrlHitsProcessed: Boolean(processedRecord),
    processedRecord: processedRecord || null,
    previousOutputExists: processedRecord?.jobDir ? existsSync(processedRecord.jobDir) : null,
    note: 'output/<slug> 会在读取页面标题后才能精确判断。'
  }, null, 2));
}

async function importPlaywrightChromium() {
  log('[boot:import] loading Playwright chromium...');
  try {
    log(`[boot:import] installed versions=${JSON.stringify(playwrightVersions())}`);
    const start = Date.now();
    log('[boot:import] requiring Playwright once in main process; first load can take 30-90s on this Mac.');
    const playwright = require('playwright');
    log(`[boot:import] Playwright module imported in ${Date.now() - start}ms`);
    return playwright.chromium;
  } catch (error) {
    log(`[boot:import] Playwright import failed: ${error.message}`);
    if (/timeout/i.test(error.message)) {
      log('Playwright import 超时，建议执行：');
      log('pkill -f "node scripts/run_mvp.mjs"');
      log('pkill -f "Chromium"');
      log('npm install');
      log('npx playwright install chromium');
    } else {
      log('如果缺 Chromium 或 Playwright 浏览器，请运行：npx playwright install chromium');
    }
    throw error;
  }
}

async function preflightPlaywrightImport() {
  const timeoutMs = Number(process.env.PLAYWRIGHT_IMPORT_TIMEOUT_MS || 15000);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/debug_import_worker.cjs'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Playwright import timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Playwright import preflight exited with code=${code} signal=${signal}`));
    });
  });
}

async function launchPersistentBrowser(userDataDir) {
  log('[browser] launching persistent context...');
  log(`[browser] userDataDir=${userDataDir}`);
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (executablePath) {
    log(`[browser] executablePath=${executablePath}`);
  }
  try {
    const start = Date.now();
    const slowTimer = setTimeout(() => {
      log('[browser] 持久化 profile 启动过慢，可能已损坏。建议 RESET_PROFILE=1。');
    }, 15000);
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...(executablePath ? { executablePath } : {}),
      env: {
        ...process.env,
        HOME: process.env.CHROME_HOME || userDataDir
      },
      viewport: { width: 1440, height: 960 },
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-crash-reporter',
        '--disable-crash-reporter-for-testing',
        '--disable-crashpad',
        '--disable-crashpad-for-testing',
        '--disable-breakpad',
        `--crash-dumps-dir=${process.env.CHROME_CRASH_DUMPS_DIR || '/tmp/xiaoe-chrome-crashpad'}`
      ]
    });
    clearTimeout(slowTimer);
    log(`[browser] launch elapsed=${Date.now() - start}ms`);
    log('[browser] persistent context launched');
    return context;
  } catch (error) {
    log(`[browser] persistent context launch failed: ${error.message}`);
    if (/Executable doesn't exist|browserType.launch|Chromium|install/i.test(error.message)) {
      log('如果缺 Chromium，请运行：npx playwright install chromium');
    }
    throw error;
  }
}

function resetBrowserProfileIfRequested() {
  if (!resetProfile) return;
  if (tempProfile) {
    log('[profile] RESET_PROFILE=1 已设置，但 TEMP_PROFILE=1 正在使用临时目录，跳过重置 browser-profile/xiaoe。');
    return;
  }

  if (existsSync(profileDir)) {
    const backupDir = `${profileDir}-broken-${Date.now()}`;
    log(`[profile] RESET_PROFILE=1：发现旧 profile，重命名为 ${backupDir}`);
    renameSync(profileDir, backupDir);
  } else {
    log(`[profile] RESET_PROFILE=1：旧 profile 不存在，将创建干净目录 ${profileDir}`);
  }
  mkdirSync(profileDir, { recursive: true });
  log(`[profile] RESET_PROFILE=1：干净 profile 已准备好 ${profileDir}`);
}

async function runDebugBrowser() {
  log('DEBUG_BROWSER=1：只测试 Playwright import、Chromium 启动、打开 example.com。');
  log('[boot:import] loading Playwright chromium...');

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/debug_browser_worker.cjs'], {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        DEBUG_BROWSER_USER_DATA_DIR: profileDir
      }
    });

    const timeoutMs = Number(process.env.DEBUG_BROWSER_TIMEOUT_MS || 120000);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      log(`[browser] DEBUG_BROWSER timed out after ${timeoutMs}ms.`);
      log('当前卡在 Playwright 模块导入或 Chromium 启动阶段。建议先尝试：');
      log('npm install @playwright/test@1.52.0 playwright@1.52.0 playwright-core@1.52.0');
      log('npx playwright install chromium');
      reject(new Error('DEBUG_BROWSER timed out'));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`DEBUG_BROWSER worker exited with code=${code} signal=${signal}`));
    });
  });
}

function runCommand(stepName, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`${stepName}：开始`);
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('exit', (code) => {
      if (code === 0) {
        log(`${stepName}：完成`);
        resolve();
      } else {
        reject(new Error(`${stepName} failed: ${command} exited with code ${code}`));
      }
    });
  });
}

async function waitForEnter(message) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(message);
  rl.close();
  return answer;
}

async function waitForPlaybackConfirmation(page) {
  while (true) {
    const answer = await waitForEnter(
      '\n自动点击失败。现在不要输入命令。请切到浏览器，手动点击播放按钮，确认开始播放后，只回到终端按 Enter：'
    );
    if (/^\s*$/.test(answer)) return;
    if (/\b(cd|npm|node|RESET_PROFILE|FORCE_RERUN|REPLAY_URL|AUDIO_DEVICE_NAME|run:mvp|npm run)\b/.test(answer)) {
      log('检测到你输入的是命令，不是回车确认。请先手动点击播放，再按 Enter。');
      continue;
    }
    log('收到非空输入。请确认浏览器里已经开始播放；如果没有，请先手动点击播放，再只按 Enter。');
  }
}

async function waitForManualLogin(page) {
  console.log('\n如果页面没有进入回放，请在打开的浏览器里扫码/登录。登录完成后回到这里按回车继续。');
  await waitForEnter('已登录并能看到回放页面后按回车：');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  log(`[login] 登录后当前 URL: ${page.url()}`);
  log(`[login] 登录后页面标题: ${await page.title().catch(() => '')}`);
}

async function getTitle(page) {
  log('获取标题：开始');
  const candidates = [
    async () => page.title(),
    async () => page.locator('h1').first().innerText({ timeout: 1500 }),
    async () => page.locator('[class*="title"]').first().innerText({ timeout: 1500 })
  ];
  for (const candidate of candidates) {
    try {
      const title = (await candidate()).trim();
      if (title && !/登录|微信登录|eLink|树成林教育/.test(title)) {
        const cleaned = title.replace(/\s+/g, ' ');
        log(`获取标题：${cleaned}`);
        return cleaned;
      }
    } catch {}
  }
  const fallbackTitle = `xiaoe-replay-${new Date().toISOString().slice(0, 10)}`;
  log(`获取标题：使用兜底标题 ${fallbackTitle}`);
  return fallbackTitle;
}

async function looksLikeLoginGate(page) {
  const signals = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const inputs = [...document.querySelectorAll('input')].map((el) => ({
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || ''
    }));
    const buttons = [...document.querySelectorAll('button, [role="button"]')].map((el) =>
      (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
    ).filter(Boolean);
    return {
      url: location.href,
      text: bodyText.slice(0, 3000),
      inputs,
      buttons
    };
  }).catch(() => ({ url: page.url(), text: '', inputs: [], buttons: [] }));

  const text = signals.text;
  const url = signals.url || page.url();
  const hasLoginText = /登录|扫码|验证码|手机号|微信|授权/.test(text);
  const hasReplayText = /播放|回放|课程|直播/.test(text);
  const hasPhoneInput = signals.inputs.some((item) => /tel|number|text/.test(item.type) && /手机|验证码|登录/.test(item.placeholder));
  const onlyLoginButton = signals.buttons.length > 0 && signals.buttons.every((label) => label === '登录');
  return /\/login\/auth/.test(url) || hasPhoneInput || onlyLoginButton || (hasLoginText && !hasReplayText);
}

async function frameLabel(frame, index) {
  const url = frame.url();
  return `${index}:${url || 'about:blank'}`;
}

async function isVideoPlaying(page) {
  for (const frame of page.frames()) {
    const playing = await frame.evaluate(async () => {
      const media = [...document.querySelectorAll('video, audio')];
      const hasPauseState = /暂停|pause/i.test(document.body?.innerText || '');
      if (!media.length) return hasPauseState;

      for (const item of media) {
        const firstTime = item.currentTime;
        const initiallyPlaying = !item.paused && !item.ended && item.readyState >= 2;
        await new Promise((resolve) => setTimeout(resolve, 1800));
        const moved = item.currentTime > firstTime + 0.2;
        if (initiallyPlaying || (!item.paused && moved)) return true;
      }

      return hasPauseState;
    }).catch(() => false);

    if (playing) return true;
  }

  return false;
}

async function collectPlayCandidates(page) {
  const all = [];
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const label = await frameLabel(frame, frameIndex);
    const candidates = await frame.evaluate(() => {
      const selector = [
        'button',
        '[role="button"]',
        '[aria-label]',
        '[title]',
        'video',
        '[class*="play" i]',
        '[class*="player" i]'
      ].join(',');

      const seen = new Set();
      return [...document.querySelectorAll(selector)]
        .filter((el) => {
          if (seen.has(el)) return false;
          seen.add(el);
          return true;
        })
        .slice(0, 120)
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          const className = typeof el.className === 'string' ? el.className : '';
          const innerText = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
          const id = el.id || '';
          const tagName = el.tagName;
          return {
            index,
            selectorHint: [
              tagName.toLowerCase(),
              id ? `#${id}` : '',
              className ? `.${className.trim().split(/\s+/).slice(0, 4).join('.')}` : ''
            ].join(''),
            tagName,
            role: el.getAttribute('role') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            text: innerText,
            innerText,
            className,
            id,
            visible: rect.width > 0 && rect.height > 0,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          };
      });
    }).catch((error) => [{ error: error.message }]);

    all.push({ frame: label, frameIndex, candidates });
  }

  return all;
}

function candidateScore(candidate) {
  const rect = candidate.rect || {};
  const width = rect.width || 0;
  const height = rect.height || 0;
  const className = candidate.className || '';
  const text = `${candidate.text || ''} ${candidate.innerText || ''} ${candidate.ariaLabel || ''} ${candidate.title || ''}`;
  const isVisible = candidate.visible;
  const isBigPlayButton = isVisible && width >= 80 && width <= 240 && height >= 80 && height <= 240;
  let score = 0;
  if (isBigPlayButton) score += 100;
  if (/play|player|播放|继续播放/i.test(`${className} ${text}`)) score += 60;
  if (/playerImg|playBtn|controlsBtn|custom_video_player_10001/i.test(className)) score += 80;
  if (candidate.tagName === 'VIDEO') score += 30;
  score -= Math.abs(width - height) * 0.2;
  return score;
}

async function clickVisibleCandidateCenters(page) {
  log('查找播放按钮：尝试可见候选元素中心点点击');
  const groups = await collectPlayCandidates(page);
  const candidates = groups
    .flatMap((group) => group.candidates.map((candidate) => ({ ...candidate, frame: group.frame, frameIndex: group.frameIndex })))
    .filter((candidate) => {
      const rect = candidate.rect || {};
      return candidate.visible && rect.width >= 80 && rect.width <= 240 && rect.height >= 80 && rect.height <= 240;
    })
    .sort((a, b) => candidateScore(b) - candidateScore(a));

  log(`查找播放按钮：可见大按钮候选 ${candidates.length} 个`);
  for (const candidate of candidates.slice(0, 10)) {
    const rect = candidate.rect;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    log(`点击播放：尝试候选中心点 index=${candidate.index} selector=${candidate.selectorHint} rect=${JSON.stringify(rect)} score=${candidateScore(candidate)}`);
    try {
      await page.mouse.click(x, y);
      await page.waitForTimeout(3000);
      if (await isVideoPlaying(page)) {
        log(`点击播放：成功，策略 候选中心点，坐标 ${Math.round(x)},${Math.round(y)}`);
        return true;
      }
      await page.waitForTimeout(2000);
      if (await isVideoPlaying(page)) {
        log(`点击播放：成功，策略 候选中心点二次等待，坐标 ${Math.round(x)},${Math.round(y)}`);
        return true;
      }
    } catch (error) {
      log(`点击播放：候选中心点失败：${error.message}`);
    }
  }

  return false;
}

async function saveDebugArtifacts(page, reason) {
  log(`调试产物：保存现场，原因：${reason}`);
  const screenshotPath = path.join(outputDir, 'debug-page.png');
  const htmlPath = path.join(outputDir, 'debug-page.html');
  const candidatesPath = path.join(outputDir, 'debug-candidates.json');
  const consolePath = path.join(outputDir, 'debug-console.log');

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch((error) => {
    log(`调试产物：截图失败 ${error.message}`);
  });
  await writeFileSync(htmlPath, await page.content().catch((error) => `<!-- page.content failed: ${error.message} -->`), 'utf8');
  const candidates = await collectPlayCandidates(page);
  writeJson(candidatesPath, candidates);
  writeFileSync(consolePath, consoleLines.join('\n') + '\n', 'utf8');

  log(`调试产物：已保存 ${screenshotPath}`);
  log(`调试产物：已保存 ${htmlPath}`);
  log(`调试产物：已保存 ${candidatesPath}`);
  log(`调试产物：已保存 ${consolePath}`);
  log('播放按钮候选元素：');
  console.log(JSON.stringify(candidates, null, 2));
}

async function clickLocatorAndCheck(page, label, locator) {
  log(`查找播放按钮：尝试 ${label}`);
  const count = await locator.count().catch(() => 0);
  if (!count) {
    log(`查找播放按钮：${label} 没找到候选`);
    return false;
  }

  for (let index = 0; index < Math.min(count, 5); index += 1) {
    try {
      const target = locator.nth(index);
      await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await target.click({ timeout: 5000, force: true });
      await page.waitForTimeout(3000);
      if (await isVideoPlaying(page)) {
        log(`点击播放：成功，策略 ${label}，候选 #${index}`);
        return true;
      }
      await page.waitForTimeout(2000);
      if (await isVideoPlaying(page)) {
        log(`点击播放：成功，策略 ${label}，候选 #${index} 二次等待`);
        return true;
      }
      log(`点击播放：${label} 候选 #${index} 点击后还未检测到播放`);
    } catch (error) {
      log(`点击播放：${label} 候选 #${index} 失败：${error.message}`);
    }
  }

  return false;
}

async function tryClickInFrames(page, label, selector) {
  for (const frame of page.frames()) {
    const ok = await clickLocatorAndCheck(page, `${label} @ ${frame.url() || 'frame'}`, frame.locator(selector));
    if (ok) return true;
  }
  return false;
}

async function clickCenterAreas(page) {
  log('查找播放按钮：尝试点击播放器区域/页面中央');
  const boxes = [];
  for (const frame of page.frames()) {
    const locator = frame.locator('video, [class*="player" i], [class*="video" i]');
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 5); index += 1) {
      const box = await locator.nth(index).boundingBox().catch(() => null);
      if (box && box.width > 80 && box.height > 80) boxes.push(box);
    }
  }

  const viewport = page.viewportSize() || { width: 1440, height: 960 };
  const points = [
    ...boxes.map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })),
    { x: viewport.width / 2, y: viewport.height / 2 },
    { x: viewport.width / 2, y: viewport.height * 0.42 }
  ];

  for (const point of points) {
    try {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(3000);
      if (await isVideoPlaying(page)) {
        log(`点击播放：成功，策略 页面坐标 ${Math.round(point.x)},${Math.round(point.y)}`);
        return true;
      }
      await page.waitForTimeout(2000);
      if (await isVideoPlaying(page)) {
        log(`点击播放：成功，策略 页面坐标二次等待 ${Math.round(point.x)},${Math.round(point.y)}`);
        return true;
      }
    } catch (error) {
      log(`点击播放：页面坐标失败：${error.message}`);
    }
  }

  return false;
}

async function clickPlay(page) {
  log('查找播放按钮：开始');
  if (await looksLikeLoginGate(page)) {
    log('[login] 查找播放按钮前发现页面已回到登录授权页，请先完成登录。');
    await detectLogin(page);
    await waitForPageToSettle(page, 'login');
  }

  if (await isVideoPlaying(page)) {
    log('查找播放按钮：检测到视频已经在播放，跳过点击');
    return true;
  }

  const customSelector = process.env.PLAY_BUTTON_SELECTOR?.trim();
  if (customSelector) {
    log(`查找播放按钮：优先使用 PLAY_BUTTON_SELECTOR=${customSelector}`);
    if (await tryClickInFrames(page, 'PLAY_BUTTON_SELECTOR', customSelector)) return true;
    await saveDebugArtifacts(page, 'PLAY_BUTTON_SELECTOR 指定了但点击后未播放');
  }

  if (await clickVisibleCandidateCenters(page)) return true;

  const selectorStrategies = [
    ['小鹅通 img.playerImg', '.img.playerImg'],
    ['小鹅通 img 标签 playerImg', 'img.playerImg'],
    ['小鹅通 playerImg', '.playerImg'],
    ['小鹅通 playBtn controlsBtn', '.playBtn.controlsBtn'],
    ['小鹅通 custom_video_player_10001', '.custom_video_player_10001'],
    ['video 元素', 'video'],
    ['aria-label 包含播放', '[aria-label*="播放"]'],
    ['aria-label 包含 play', '[aria-label*="play" i]'],
    ['title 包含播放', '[title*="播放"]'],
    ['title 包含 play', '[title*="play" i]'],
    ['button 文字包含继续播放', 'button:has-text("继续播放")'],
    ['role=button 文字包含继续播放', '[role="button"]:has-text("继续播放")'],
    ['页面文字包含继续播放', 'text=继续播放'],
    ['button 文字包含播放', 'button:has-text("播放")'],
    ['role=button 文字包含播放', '[role="button"]:has-text("播放")'],
    ['页面文字包含播放', 'text=播放'],
    ['常见 play class', '[class*="play" i]'],
    ['常见 player/video 控件', 'video, [class*="player" i], [class*="video" i]']
  ];

  for (const [label, selector] of selectorStrategies) {
    if (await looksLikeLoginGate(page)) {
      log('[login] 查找播放按钮过程中发现页面回到登录授权页，请先完成登录。');
      await detectLogin(page);
      await waitForPageToSettle(page, 'login');
      if (await isVideoPlaying(page)) return true;
    }
    if (await tryClickInFrames(page, label, selector)) return true;
  }

  if (await clickCenterAreas(page)) return true;

  await saveDebugArtifacts(page, '自动播放按钮识别全部失败');
  await waitForPlaybackConfirmation(page);
  await page.waitForTimeout(1200);

  if (await isVideoPlaying(page)) {
    log('点击播放：手动兜底后检测到正在播放');
    await saveDebugArtifacts(page, '手动兜底播放成功后的 DOM 记录');
    return true;
  }

  await saveDebugArtifacts(page, '手动兜底后仍未检测到播放');
  throw new Error('Unable to start playback. Debug artifacts saved in output/.');
}

async function setupConsoleCapture(page) {
  page.on('console', (msg) => {
    consoleLines.push(`[${new Date().toISOString()}] ${msg.type()} ${msg.text()}`);
  });
  page.on('pageerror', (error) => {
    consoleLines.push(`[${new Date().toISOString()}] pageerror ${error.message}`);
  });
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      log(`[open] 页面跳转，当前 URL: ${frame.url()}`);
    }
  });
}

async function detectLogin(page) {
  log('检测登录：开始');
  const loginGate = await looksLikeLoginGate(page);
  if (loginGate) {
    log('[login] 当前在登录授权页，请完成登录后按回车继续。');
    await waitForManualLogin(page);
    log('检测登录：已继续，登录态会保存在 browser profile');
  } else {
    log('检测登录：未发现明显登录拦截，继续处理');
  }
}

async function waitForPageToSettle(page, label = 'open') {
  const beforeUrl = page.url();
  log(`[${label}] 等待页面跳转稳定，当前 URL: ${beforeUrl}`);
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const afterUrl = page.url();
  if (afterUrl !== beforeUrl) {
    log(`[${label}] 等待后 URL 已变化: ${afterUrl}`);
  } else {
    log(`[${label}] 页面 URL 已稳定: ${afterUrl}`);
  }
}

async function detectBrokenPlaybackPage(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const compactText = bodyText.replace(/\s+/g, ' ').trim();

  if (!url || url === 'about:blank') return '页面仍停留在空白页';
  if (/加载失败|网络后重试|检查网络|页面无法打开|This site can’t be reached|ERR_/i.test(`${title} ${compactText}`)) {
    return `页面加载失败：${title || compactText.slice(0, 80)}`;
  }
  if (await looksLikeLoginGate(page)) {
    return '页面仍停留在登录授权页';
  }
  return '';
}

async function runPipeline(jobDir, title) {
  log('[record] 即将录制 BlackHole 2ch。');
  log('[record] 请确认 macOS 系统输出为“多输出设备”，且其中包含 MacBook Air 扬声器 + BlackHole 2ch。');
  log('[record] 请确认当前小鹅通页面正在播放，且你自己能听到声音。');
  log(`启动录音：${recordSeconds} 秒`);
  await runCommand('录音与转写', pythonBin, [
    'py/record_transcribe.py',
    '--title', title,
    '--job-dir', jobDir,
    '--seconds', String(recordSeconds)
  ]);

  log('录音结束：recording.wav 应已生成');
  log('转写完成：transcript_raw.md 应已生成');

  await runCommand('清洗逐字稿', 'node', ['scripts/clean_transcript.mjs', '--job-dir', jobDir, '--title', title]);
  log('清洗完成：transcript_clean.md 应已生成');

  await runCommand('写入飞书', 'node', ['scripts/feishu_doc.mjs', '--job-dir', jobDir, '--title', title]);
  log('飞书写入完成：feishu_doc_url.txt 应已生成');

  await runCommand('写入飞书多维表格索引', 'node', ['scripts/feishu_base_index.mjs', '--job-dir', jobDir, '--title', title]).catch((error) => {
    log(`飞书多维表格索引写入失败，但文档链接已保留：${error.message}`);
  });
}

async function runOpenChromeFallback(processed) {
  const title = process.env.MANUAL_TITLE || '小鹅通回放手动采集';
  const slug = `manual-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
  const jobDir = path.resolve(outputDir, slug);

  log('[fallback] BROWSER_DRIVER=open-chrome：绕开 Playwright，直接用系统 Chrome 打开链接。');
  log('[fallback] 这个模式会打开浏览器并录音；请在倒计时内确认页面开始播放。');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, 'source_url.txt'), replayUrl);

  const chromeAppPath = process.env.CHROME_APP_PATH || '/Applications/Google Chrome.app';
  const chromeExecutablePath = process.env.BROWSER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try {
    await runCommand('打开 Chrome', 'open', ['-a', chromeAppPath, replayUrl]);
  } catch (error) {
    log(`[fallback] 用 macOS open 打开失败，改用 Chrome 二进制直接启动：${error.message}`);
    launchChromeBinary(chromeExecutablePath, replayUrl);
  }
  log(`[fallback] 已请求系统 Chrome 打开：${replayUrl}`);

  if (dryRun) {
    log('DRY_RUN：已打开 Chrome，跳过录音/转写/飞书。');
    return;
  }

  log(`[fallback] ${manualStartDelaySeconds} 秒后开始录音。请确认小鹅通页面已播放，且你能听到声音。`);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, manualStartDelaySeconds) * 1000));
  await runPipeline(jobDir, title);

  processed[replayUrl] = {
    status: 'done',
    title,
    jobDir,
    replayUrl,
    feishuDocUrl: existsSync(path.join(jobDir, 'feishu_doc_url.txt')) ? readFileSync(path.join(jobDir, 'feishu_doc_url.txt'), 'utf8').trim() : '',
    finishedAt: new Date().toISOString()
  };
  writeJson(processedPath, processed);
  log(`写入 processed.json：${processedPath}`);
}

function launchChromeBinary(executablePath, url) {
  if (!existsSync(executablePath)) {
    throw new Error(`Chrome executable not found: ${executablePath}`);
  }
  const child = spawn(executablePath, [url], {
    cwd,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  log(`[fallback] Chrome 二进制已启动：${executablePath}`);
}

async function main() {
  const processed = readJson(processedPath, {});
  printStartupDiagnostics(processed);

  if (debugStartup) {
    log('DEBUG_STARTUP=1：启动诊断完成，不打开浏览器、不录音、不转写、不写飞书。');
    return;
  }

  if (debugBrowser) {
    await runDebugBrowser();
    return;
  }

  mkdirSync(path.dirname(processedPath), { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  resetBrowserProfileIfRequested();

  if (!forceRerun && processed[replayUrl]?.status === 'done') {
    log(`断点续跑：该链接已处理，跳过：${processed[replayUrl].title}`);
    log('该链接已处理，跳过。如需重跑，请删除 output/<slug> 和 data/processed.json，或设置 FORCE_RERUN=1。');
    return;
  }

  if (forceRerun && processed[replayUrl]) {
    log('FORCE_RERUN=1：忽略 processed.json 中已有记录，强制重新打开链接。');
  }

  if (browserDriver === 'open-chrome') {
    await runOpenChromeFallback(processed);
    return;
  }

  log(`启动模式：${dryRun ? 'DRY_RUN，只测页面和播放，不录音/转写/写飞书' : '完整 MVP'}`);
  log('[browser] browser headless=false');
  log(`[browser] userDataDir=${profileDir}`);
  log(`[open] 正在打开 REPLAY_URL: ${replayUrl}`);
  chromium = await importPlaywrightChromium();
  log('[boot:import] loading slugify...');
  slugify = (await import('slugify')).default;
  log('[boot:import] slugify loaded');
  const browser = await launchPersistentBrowser(profileDir);

  const page = browser.pages()[0] || await browser.newPage();
  await setupConsoleCapture(page);
  await page.bringToFront().catch(() => {});

  try {
    await page.goto(replayUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.bringToFront().catch(() => {});
    await waitForPageToSettle(page, 'open');
    log(`[open] 页面加载完成，当前 URL: ${page.url()}`);
    log(`[open] 页面标题: ${await page.title().catch(() => '')}`);
    await detectLogin(page);
    await waitForPageToSettle(page, 'login');
    await page.bringToFront().catch(() => {});

    const brokenReason = await detectBrokenPlaybackPage(page);
    if (brokenReason) {
      await saveDebugArtifacts(page, brokenReason);
      throw new Error(`${brokenReason}. Debug artifacts saved in output/.`);
    }

    let title = await getTitle(page);
    if (await looksLikeLoginGate(page)) {
      log('[login] 获取标题后发现仍在登录授权页，先暂停登录，不进入播放按钮流程。');
      await detectLogin(page);
      await waitForPageToSettle(page, 'login');
      await page.bringToFront().catch(() => {});
      if (await looksLikeLoginGate(page)) {
        await saveDebugArtifacts(page, '登录后仍停留在登录授权页');
        throw new Error('仍停留在登录授权页，请确认登录完成后再采集。Debug artifacts saved in output/.');
      }
      title = await getTitle(page);
    }
    const slug = slugify(title, { lower: true, strict: true }) || `xiaoe-${Date.now()}`;
    const jobDir = path.resolve(outputDir, slug);
    log(`[output] 当前 output/<slug>: ${jobDir}`);
    log(`[output] 当前是否存在 output/<slug>: ${existsSync(jobDir)}`);
    if (forceRerun && existsSync(jobDir)) {
      log(`[output] FORCE_RERUN=1：清理旧输出目录 ${jobDir}`);
      rmSync(jobDir, { recursive: true, force: true });
    }
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(path.join(jobDir, 'source_url.txt'), replayUrl);

    log('[player] 已进入播放页，开始查找播放按钮。');
    log(`点击播放：准备处理 ${title}`);
    await clickPlay(page);
    await page.waitForTimeout(2000);

    if (dryRun) {
      log('DRY_RUN：已完成打开、登录检测、标题读取、播放按钮查找和点击；跳过录音/转写/清洗/飞书');
      return;
    }

    await runPipeline(jobDir, title);

    processed[replayUrl] = {
      status: 'done',
      title,
      jobDir,
      feishuDocUrl: existsSync(path.join(jobDir, 'feishu_doc_url.txt')) ? readFileSync(path.join(jobDir, 'feishu_doc_url.txt'), 'utf8').trim() : '',
      finishedAt: new Date().toISOString()
    };
    writeJson(processedPath, processed);
    log(`写入 processed.json：${processedPath}`);
  } catch (error) {
    await saveDebugArtifacts(page, `任务失败：${error.message}`).catch(() => {});
    const failed = readJson(failedPath, []);
    failed.push({
      url: replayUrl,
      error: error.message,
      failedAt: new Date().toISOString()
    });
    writeJson(failedPath, failed);
    log(`写入 failed_jobs.json：${failedPath}`);
    throw error;
  } finally {
    log('关闭浏览器');
    await browser.close().catch((closeError) => {
      log(`[browser] 浏览器已关闭或关闭失败，忽略该关闭错误：${closeError.message}`);
    });
  }
}

main().catch((error) => {
  console.error('[main:error]', error);
  process.exitCode = 1;
});
