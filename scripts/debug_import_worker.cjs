console.log('[debug:import:worker] before require playwright');
console.log('[debug:import:worker] cwd', process.cwd());
console.log('[debug:import:worker] node', process.version);

try {
  const playwright = require('playwright');
  console.log('[debug:import:worker] after require playwright', Boolean(playwright.chromium));
} catch (error) {
  console.error('[debug:import:worker] require failed');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
