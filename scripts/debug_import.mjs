console.log('[debug:import] parent started');
console.log('[debug:import] node', process.version);

const { spawn } = await import('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
const path = (await import('node:path')).default;

const debugDir = path.resolve(process.cwd(), 'output');
mkdirSync(debugDir, { recursive: true });
const debugLogPath = path.join(debugDir, 'debug-import.log');
writeFileSync(debugLogPath, `[debug:import] started ${new Date().toISOString()}\n`);

function versionOf(name) {
  try {
    return JSON.parse(readFileSync(path.resolve(process.cwd(), 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return 'not-installed';
  }
}

console.log('[debug:import] versions', JSON.stringify({
  playwright: versionOf('playwright'),
  '@playwright/test': versionOf('@playwright/test'),
  'playwright-core': versionOf('playwright-core')
}));

const timeoutMs = Number(process.env.PLAYWRIGHT_IMPORT_TIMEOUT_MS || 15000);

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/debug_import_worker.cjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    writeFileSync(debugLogPath, chunk, { flag: 'a' });
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    writeFileSync(debugLogPath, chunk, { flag: 'a' });
  });

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    reject(new Error(`Playwright import timeout after ${timeoutMs / 1000}s`));
  }, timeoutMs);

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`debug import worker exited with code=${code} signal=${signal}`));
  });
}).catch((error) => {
  console.error('[debug:import] import failed:', error.message);
  console.error('[debug:import] full log:', debugLogPath);
  if (/timeout/i.test(error.message)) {
    console.error('[debug:import] suggested commands:');
    console.error('pkill -f "node scripts/run_mvp.mjs"');
    console.error('pkill -f "Chromium"');
    console.error('npm install');
    console.error('npx playwright install chromium');
  }
  process.exitCode = 1;
});
