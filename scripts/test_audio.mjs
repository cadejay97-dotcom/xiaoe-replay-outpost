import './load_env.mjs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const cwd = process.cwd();
const pythonBin = process.env.PYTHON_BIN || (existsSync(path.resolve(cwd, '.venv/bin/python')) ? path.resolve(cwd, '.venv/bin/python') : 'python3');
const jobDir = process.env.AUDIO_TEST_JOB_DIR || 'output/audio-test';
const seconds = process.env.AUDIO_TEST_SECONDS || '10';

console.log('[audio-test] started');
console.log(`[audio-test] cwd=${cwd}`);
console.log(`[audio-test] python=${pythonBin}`);
console.log(`[audio-test] AUDIO_DEVICE_NAME=${process.env.AUDIO_DEVICE_NAME || ''}`);
console.log(`[audio-test] AUDIO_DEVICE_INDEX=${process.env.AUDIO_DEVICE_INDEX || ''}`);
console.log(`[audio-test] seconds=${seconds}`);
console.log(`[audio-test] jobDir=${jobDir}`);

const child = spawn(pythonBin, [
  '-u',
  'py/record_transcribe.py',
  '--title', process.env.AUDIO_TEST_TITLE || 'audio-test',
  '--job-dir', jobDir,
  '--seconds', seconds,
  '--audio-test-only'
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHONUNBUFFERED: '1',
  },
});

child.on('exit', (code) => {
  console.log(`[audio-test] finished with code=${code ?? 1}`);
  process.exit(code ?? 1);
});
