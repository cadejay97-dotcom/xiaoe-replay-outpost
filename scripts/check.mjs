import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cwd = process.cwd();
const jsDirs = ['scripts', 'public'];
const pyDirs = ['py'];

function walk(dir, predicate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') return [];
      return walk(file, predicate);
    }
    return predicate(file) ? [file] : [];
  });
}

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${command} exited with code ${result.status}`);
  }
}

const jsFiles = jsDirs.flatMap((dir) =>
  walk(path.resolve(cwd, dir), (file) => /\.(mjs|cjs|js)$/.test(file))
);
const pyFiles = pyDirs.flatMap((dir) =>
  walk(path.resolve(cwd, dir), (file) => file.endsWith('.py'))
);

for (const file of jsFiles) {
  run(`node syntax ${path.relative(cwd, file)}`, process.execPath, ['--check', file]);
}

if (pyFiles.length) {
  run('python syntax', process.env.PYTHON_BIN || 'python3', ['-m', 'py_compile', ...pyFiles]);
}

console.log(`[check] OK: ${jsFiles.length} JS files, ${pyFiles.length} Python files`);
