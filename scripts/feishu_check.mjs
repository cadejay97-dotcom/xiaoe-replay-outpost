import { spawnSync } from 'node:child_process';

const requiredScopes = [
  'docx:document',
  'docx:document:create'
];

function run(args) {
  return spawnSync('lark-cli', args, { encoding: 'utf8' });
}

function printResult(label, result) {
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  console.log(`[feishu-check] ${label}`);
  if (output) console.log(output);
}

console.log('[feishu-check] 检查飞书 CLI 登录和文档写入权限');

const status = run(['auth', 'status']);
printResult('auth status', status);
if (status.status !== 0) {
  process.exitCode = 1;
  console.log('[feishu-check] 请先运行：lark-cli auth login --scope "docx:document"');
}

let missing = false;
for (const scope of requiredScopes) {
  const result = run(['auth', 'check', '--scope', scope]);
  printResult(`scope ${scope}`, result);
  if (result.status !== 0) missing = true;
}

if (missing) {
  console.log('[feishu-check] 需要补充授权：');
  for (const scope of requiredScopes) {
    console.log(`lark-cli auth login --scope "${scope}"`);
  }
  process.exitCode = 1;
} else {
  console.log('[feishu-check] 飞书文档创建/写入权限已就绪。');
}
