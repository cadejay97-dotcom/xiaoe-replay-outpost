const fs = require('fs');
const path = require('path');
const Module = require('module');

const logPath = path.resolve(process.cwd(), 'output/debug-require-trace.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, `[trace] started ${new Date().toISOString()}\n`);

function write(line) {
  fs.writeFileSync(logPath, `${line}\n`, { flag: 'a' });
  console.log(line);
}

const originalLoad = Module._load;
let count = 0;

Module._load = function patchedLoad(request, parent, isMain) {
  count += 1;
  const parentFile = parent && parent.filename ? parent.filename.replace(process.cwd(), '.') : '';
  write(`[load] ${count} request=${request} parent=${parentFile}`);
  return originalLoad.apply(this, arguments);
};

setTimeout(() => {
  write(`[trace] timeout after ${process.env.REQUIRE_TRACE_TIMEOUT_MS || 15000}ms`);
  write(`[trace] log=${logPath}`);
  process.exit(2);
}, Number(process.env.REQUIRE_TRACE_TIMEOUT_MS || 15000));

const target = process.env.REQUIRE_TRACE_TARGET || 'playwright';
write(`[trace] before require ${target}`);
try {
  const loaded = require(target);
  write(`[trace] after require ${target} ok=${Boolean(loaded)}`);
  process.exit(0);
} catch (error) {
  write('[trace] require failed');
  write(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
