const { chromium } = require('playwright');

async function main() {
  const userDataDir = process.env.DEBUG_BROWSER_USER_DATA_DIR;
  console.log('[boot:import] Playwright module imported');
  console.log('[browser] launching persistent context...');
  console.log(`[browser] userDataDir=${userDataDir}`);

  let browser;
  try {
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH || '';
    if (executablePath) {
      console.log(`[browser] executablePath=${executablePath}`);
    }
    const crashDumpsDir = process.env.CHROME_CRASH_DUMPS_DIR || '/tmp/xiaoe-chrome-crashpad';
    browser = await chromium.launchPersistentContext(userDataDir, {
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
        `--crash-dumps-dir=${crashDumpsDir}`
      ]
    });
  } catch (error) {
    console.error(`[browser] persistent context launch failed: ${error.message}`);
    if (/Executable doesn't exist|Chromium|install/i.test(error.message)) {
      console.error('如果缺 Chromium，请运行：npx playwright install chromium');
    }
    if (/Crashpad|settings\.dat|Operation not permitted|Permission denied/i.test(error.message)) {
      console.error('[browser] 检测到 Chromium Crashpad 权限问题。');
      console.error('[browser] 请给当前运行命令的 App 完全磁盘访问权限：系统设置 -> 隐私与安全性 -> 完全磁盘访问权限。');
      console.error('[browser] 如果你在 Terminal 跑命令，就给 Terminal；如果在 Codex/Cursor 跑，就给对应 App。授权后彻底退出再打开。');
    }
    process.exitCode = 1;
    return;
  }

  console.log('[browser] persistent context launched');
  try {
    const page = browser.pages()[0] || await browser.newPage();
    console.log('[browser] page created');
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[browser] current URL=${page.url()}`);
    console.log(`[browser] test page title=${await page.title().catch(() => '')}`);
  } finally {
    console.log('[browser] closing persistent context');
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[browser] debug worker failed:', error);
  process.exitCode = 1;
});
