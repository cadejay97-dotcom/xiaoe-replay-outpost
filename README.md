# 小鹅通前哨站回放无人值守采集系统

边界：只自动化你已经有权限观看的网页播放行为，并录制本机系统音频。它不破解视频、不绕过权限、不抓取受保护视频源地址。

## 一键安装

```bash
npm install
npm run install:browsers
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

macOS 录系统音频通常需要安装虚拟声卡，例如 BlackHole 2ch，并把系统声音路由到它。

## BlackHole 正确配置

1. 安装 BlackHole 2ch。
2. 打开 macOS 的“音频 MIDI 设置”。
3. 创建“多输出设备”。
4. 勾选 MacBook Air 扬声器 + BlackHole 2ch。
5. 打开“系统设置” → “声音” → “输出”，选择刚创建的多输出设备。
6. `.env` 里仍然保持 `AUDIO_DEVICE_NAME="BlackHole 2ch"`，因为 ffmpeg 录的是 BlackHole 这一路。

如果 ffmpeg 列表里显示：

```text
[0] BlackHole 2ch
[1] MacBook Air麦克风
```

仍然优先按名字录：

```bash
AUDIO_DEVICE_NAME="BlackHole 2ch" npm run test:audio
```

不推荐默认使用 `AUDIO_DEVICE_INDEX`。编号在不同 app、不同权限状态下可能漂移；只有在你确认当前运行环境里编号稳定，并且没有设置 `AUDIO_DEVICE_NAME` 时，才用 `AUDIO_DEVICE_INDEX`。

先做 10 秒音频测试：

```bash
AUDIO_DEVICE_NAME="BlackHole 2ch" npm run test:audio
```

它只录音，不打开小鹅通、不转写、不写飞书。输出在：

- `output/audio-test/recording.wav`
- `output/audio-test/audio_report.json`

如果报告提示“录音可能是静音”，优先检查系统输出是否真的选中了“多输出设备”。

如果你想自己手动打开网页/音乐并播放，只测试系统声音有没有进 BlackHole：

```bash
AUDIO_DEVICE_NAME="BlackHole 2ch" npm run record:manual
```

它会录 60 秒，输出到：

- `output/manual-record-test/recording.wav`
- `output/manual-record-test/audio_report.json`

如果报告提示 `录音设备打不开`，通常是权限或设备编号问题：

1. 打开“系统设置” → “隐私与安全性” → “麦克风”。
2. 给你运行命令的 app 打开权限，例如 Terminal、iTerm、Cursor、Codex。
3. 退出并重新打开这个 app。
4. 重新运行：

```bash
ffmpeg -f avfoundation -list_devices true -i ""
```

能看到 `BlackHole 2ch` 后，再运行：

```bash
AUDIO_DEVICE_NAME="BlackHole 2ch" npm run test:audio
```

## 一键运行 MVP

```bash
REPLAY_URL="你的小鹅通回放链接" npm run run:mvp
```

第一次运行如果未登录，脚本会暂停，你扫码登录成功后回到终端按回车。登录态会保存在 `browser-profile/xiaoe`。

如果之前有旧输出或 `processed.json` 导致跳过，用强制重跑：

```bash
FORCE_RERUN=1 RECORD_SECONDS=60 AUDIO_DEVICE_NAME="BlackHole 2ch" REPLAY_URL="https://rn6vx.xetslk.com/sl/2ZTCjx" npm run run:mvp
```

默认是完整录制优先：Playwright 会尝试检测播放器结束并停止录音；`RECORD_SECONDS` 是最长保护时长，防止异常无限录制。前端采集台里不用手算秒，可以直接填“小时 / 分钟 / 秒”。

默认使用 Playwright 控制可见的系统 Chrome：

```bash
BROWSER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BROWSER_DRIVER="playwright"
RECORD_MODE="complete"
```

如果 Playwright 在本机卡在 import 阶段，可以临时用兜底模式跑通采集：

```bash
BROWSER_DRIVER="open-chrome"
MANUAL_START_DELAY_SECONDS=20
```

这个模式会直接打开系统 Chrome，等待 20 秒后开始录音。它不能检测播放器结束，只会按最长保护时长停止。

## 已有录音后处理

已经有 `output/2026315/recording.wav` 时，不用重新打开小鹅通，直接跑：

```bash
npm run postprocess:existing
```

它会依次执行：

- 转写 `recording.wav` 到 `transcript_raw.md`
- 清洗成 `transcript_clean.md`
- 用 `lark-cli` 创建飞书文档
- 保存 `feishu_doc_url.txt`
- 写入飞书多维表格索引
- 更新 `data/processed.json`

多维表格字段默认是：

```text
广泛解答 = 回放标题
视频链接 = 小鹅通回放链接
文本链接 = 飞书文档链接
SourceID = 本地任务 ID / output 目录名
```

暂时不写 `封面`、`编号`、`解答总结`。

## 飞书 CLI 写入检查

先在普通 Terminal 里检查飞书 CLI 是否能创建文档：

```bash
npm run feishu:check
```

如果提示缺权限，按输出补充授权，常见是：

```bash
lark-cli auth login --scope "docx:document"
lark-cli auth login --scope "docx:document:create"
```

如果提示 `keychain not initialized`，请在普通 Terminal 里运行，不要在受限沙箱或 CI 环境里运行；仍失败时重新执行 `lark-cli config init`。

权限就绪后，可以用一份最小测试文稿验证真实创建：

```bash
node scripts/feishu_doc.mjs --job-dir output/feishu-cli-test --title "前哨站采集系统飞书写入验证"
```

## 本地采集台

启动本地前端：

```bash
npm run serve
```

打开：

```text
http://localhost:8787
```

```text
http://localhost:8787
```

采集台可以：

- 输入回放链接并启动采集
- 对现有录音执行后处理
- 查看任务状态
- 直接看到飞书文档链接

## 调试播放按钮

先跑短链路，只验证打开页面、登录态、标题和自动点击播放：

```bash
DRY_RUN=1 REPLAY_URL="你的小鹅通回放链接" npm run run:mvp
```

如果自动点击失败，会保存：

- `output/debug-page.png`
- `output/debug-page.html`
- `output/debug-candidates.json`
- `output/debug-console.log`

如果页面按钮特别隐蔽，可以在 `.env` 指定：

```bash
PLAY_BUTTON_SELECTOR=".player-play-button"
```

短录测试：

```bash
RECORD_SECONDS=60 REPLAY_URL="你的小鹅通回放链接" npm run run:mvp
```

调试阶段默认使用 `WHISPER_MODEL="small"`，等整条链路跑通后再改成 `large-v3`。

## 使用火山 ASR

如果本地 faster-whisper 太慢，可以在 `.env` 切到火山：

```bash
TRANSCRIBE_PROVIDER="volcengine"
VOLCENGINE_ASR_URL="你的火山 ASR endpoint"
VOLCENGINE_ASR_TOKEN="你的 token"
VOLCENGINE_ASR_REQUEST_FORMAT="multipart"
VOLCENGINE_ASR_TEXT_PATH="result.text"
```

如果火山接口要求 JSON base64，把格式改成：

```bash
VOLCENGINE_ASR_REQUEST_FORMAT="json_base64"
VOLCENGINE_ASR_AUDIO_FIELD="audio"
VOLCENGINE_ASR_PAYLOAD_JSON='{"language":"zh"}'
```

已经录好音时，不用重新打开小鹅通，可以只对现有音频转写：

```bash
TRANSCRIBE_PROVIDER="volcengine" npm run transcribe:existing
```

它会读取 `output/2026315/recording.wav`，生成：

- `output/2026315/transcript_raw.md`
- `output/2026315/volcengine_asr_response.json`

## 输出

- `output/<标题>/recording.wav`
- `output/<标题>/transcript_raw.md`
- `output/<标题>/transcript_clean.md`
- `output/<标题>/feishu_doc_url.txt`
- `data/processed.json`
- `data/failed_jobs.json`
