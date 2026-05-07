import './load_env.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const jobDir = path.resolve(process.cwd(), getArg('--job-dir'));
const title = getArg('--title', '小鹅通回放整理');
const cleanPath = path.join(jobDir, 'transcript_clean.md');
const urlPath = path.join(jobDir, 'feishu_doc_url.txt');

function extractUrl(text) {
  const match = text.match(/https:\/\/[^\s")]+/);
  if (match?.[0]) return match[0];

  try {
    const json = JSON.parse(text);
    const found = findString(json, (value) => value.startsWith('https://'));
    if (found) return found;
    const token = findString(json, (_value, key) => /token/i.test(key) || /document_id/i.test(key));
    return token || '';
  } catch {
    return '';
  }
}

function findString(value, predicate, key = '') {
  if (typeof value === 'string') return predicate(value, key) ? value : '';
  if (!value || typeof value !== 'object') return '';
  for (const [childKey, childValue] of Object.entries(value)) {
    const found = findString(childValue, predicate, childKey);
    if (found) return found;
  }
  return '';
}

function createWithLarkCli(markdown) {
  const content = `# ${title}\n\n${markdown}`;
  const uploadPath = path.join(jobDir, '.feishu_upload.md');
  const uploadArgPath = path.relative(process.cwd(), uploadPath);
  writeFileSync(uploadPath, content, 'utf8');

  const args = [
    'docs',
    '+create',
    '--api-version',
    'v2',
    '--as',
    'user',
    '--title',
    title,
    '--markdown',
    `@${uploadArgPath}`
  ];
  const folderToken = process.env.FEISHU_DOC_PARENT_FOLDER_TOKEN?.trim();
  if (folderToken) args.push('--folder-token', folderToken);

  const result = spawnSync(
    'lark-cli',
    args,
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    const output = result.stderr || result.stdout;
    if (output.includes('keychain not initialized')) {
      throw new Error([
        'lark-cli 无法读取本机 keychain。请在普通 Terminal 里运行飞书写入命令，不要在受限沙箱里运行。',
        '如果普通 Terminal 也失败，请重新初始化：lark-cli config init'
      ].join('\n'));
    }
    if (output.includes('permission') || output.includes('scope') || output.includes('missing')) {
      throw new Error([
        '飞书文档写入权限不足。请先补充授权：',
        'lark-cli auth login --scope "docx:document"',
        'lark-cli auth login --scope "docx:document:create"',
        '',
        output
      ].join('\n'));
    }
    throw new Error(`lark-cli failed:\n${output}`);
  }

  const text = `${result.stdout}\n${result.stderr}`;
  const extracted = extractUrl(text);
  if (!extracted) {
    throw new Error(`lark-cli created document but no URL/token was found:\n${text}`);
  }
  return normalizeDocUrl(extracted);
}

function normalizeDocUrl(value) {
  if (value.startsWith('https://')) return value;
  const baseUrl = process.env.FEISHU_DOC_BASE_URL?.trim() || process.env.FEISHU_BASE_DOMAIN?.trim() || 'https://zcn93ri8jhkc.feishu.cn';
  return `${baseUrl.replace(/\/$/, '')}/docx/${value}`;
}

async function main() {
  console.log(`[feishu] 开始写入飞书：${title}`);
  if (!existsSync(cleanPath)) {
    throw new Error(`Missing ${cleanPath}`);
  }

  const markdown = readFileSync(cleanPath, 'utf8');
  const writer = process.env.FEISHU_WRITER || 'lark-cli';

  if (writer !== 'lark-cli') {
    throw new Error('MVP currently supports FEISHU_WRITER=lark-cli. Direct Open Platform REST can be added after app scopes are confirmed.');
  }

  const docUrl = createWithLarkCli(markdown);
  writeFileSync(urlPath, docUrl + '\n', 'utf8');
  console.log(`[feishu] 飞书文档链接已保存：${urlPath}`);
  console.log(docUrl);
}

main();
