import './load_env.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OpenAI } from 'openai';

const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const jobDir = path.resolve(process.cwd(), getArg('--job-dir'));
const title = getArg('--title', '小鹅通回放');
const raw = readFileSync(path.join(jobDir, 'transcript_raw.md'), 'utf8');

function hasTranscriptBody(text) {
  const contentLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .filter((line) => !line.startsWith('- language:'))
    .filter((line) => !line.startsWith('- duration:'));

  return contentLines.some((line) => /\]\s*\S+/.test(line) || line.length > 20);
}

const prompt = `你是我的学习资料整理助手。请把下面的小鹅通课程逐字稿整理成结构化 Markdown。

要求：
1. 不要编造课程里没有的信息。
2. 如果逐字稿有识别错误，按上下文做轻度修正，但不要改写成鸡汤文。
3. 保留“对我做 AI 操盘手 / 内容 IP / token 现金流 / 知识库系统的启发”这一节，尽量具体。
4. 最后一节放完整原始逐字稿。

输出结构：
# ${title}

## 核心观点

## 分章节摘要

## 关键案例

## 可执行动作

## 对我做 AI 操盘手 / 内容 IP / token 现金流 / 知识库系统的启发

## 原始逐字稿

逐字稿如下：
${raw}`;

async function main() {
  console.log(`[clean] 开始清洗：${title}`);
  if (!hasTranscriptBody(raw)) {
    const diagnostic = `# ${title}

## 核心观点

本次没有识别到有效逐字稿正文。

## 分章节摘要

暂无。当前 \`transcript_raw.md\` 只有音频元信息，没有识别出的语音内容。

## 关键案例

暂无。

## 可执行动作

- 先运行 \`npm run test:audio\`。
- 打开 \`output/audio-test/audio_report.json\`，确认 \`is_probably_silent\` 是 \`false\`。
- 如果仍然是静音，检查 macOS 输出是否选择了“多输出设备”，并确认 BlackHole 2ch 被勾选。
- 确认小鹅通网页播放器、浏览器标签页、系统音量都没有静音。

## 对我做 AI 操盘手 / 内容 IP / token 现金流 / 知识库系统的启发

这次链路已经跑到“播放 -> 录音 -> 转写”，但音频输入还需要先校准。先把采集入口打稳，再进入批量入库，否则会批量生成空稿。

## 原始逐字稿

${raw}`;
    writeFileSync(path.join(jobDir, 'transcript_clean.md'), diagnostic, 'utf8');
    console.log('[clean] 未检测到有效逐字稿正文，已生成诊断清洗稿，跳过 LLM');
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    const fallback = `# ${title}\n\n## 核心观点\n\n待整理：缺少 OPENAI_API_KEY，已保留原始逐字稿。\n\n## 原始逐字稿\n\n${raw}`;
    writeFileSync(path.join(jobDir, 'transcript_clean.md'), fallback);
    console.log('[clean] 缺少 OPENAI_API_KEY，已生成兜底清洗稿');
    return;
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4.1-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2
  });

  writeFileSync(
    path.join(jobDir, 'transcript_clean.md'),
    response.choices[0].message.content || '',
    'utf8'
  );
  console.log(`[clean] 清洗完成：${path.join(jobDir, 'transcript_clean.md')}`);
}

main();
