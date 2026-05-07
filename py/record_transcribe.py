import argparse
import base64
import json
import os
import re
import subprocess
import uuid
from pathlib import Path
from urllib import request

from dotenv import load_dotenv

load_dotenv()


def run(cmd):
    print(" ".join(cmd))
    return subprocess.run(cmd, check=True, text=True, capture_output=True)


def run_capture(cmd):
    result = subprocess.run(cmd, check=True, text=True, capture_output=True)
    return result.stdout, result.stderr


def list_avfoundation_audio_devices():
    result = subprocess.run(
        ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        text=True,
        capture_output=True,
        check=False,
    )
    devices = []
    in_audio_section = False
    for line in result.stderr.splitlines():
        if "AVFoundation audio devices" in line:
            in_audio_section = True
            continue
        if "AVFoundation video devices" in line:
            in_audio_section = False
            continue
        if not in_audio_section:
            continue
        match = re.search(r"\[(\d+)\]\s+(.+)$", line)
        if match:
            devices.append({"index": match.group(1), "name": match.group(2).strip()})
    return devices, result.stderr


def resolve_audio_input(device_name: str):
    if device_name:
        explicit_index = os.getenv("AUDIO_DEVICE_INDEX", "").strip()
        if explicit_index:
            print("[record] 同时设置了 AUDIO_DEVICE_NAME 和 AUDIO_DEVICE_INDEX，优先使用 AUDIO_DEVICE_NAME。")
        print(f"[record] 使用 AUDIO_DEVICE_NAME={device_name}")
        return f":{device_name}"

    explicit_index = os.getenv("AUDIO_DEVICE_INDEX", "").strip()
    if explicit_index:
        print(f"[record] 未设置 AUDIO_DEVICE_NAME，使用 AUDIO_DEVICE_INDEX={explicit_index}")
        return f":{explicit_index}"

    devices, raw_list = list_avfoundation_audio_devices()
    print(f"[record] avfoundation audio devices: {devices}")
    print("[record] 未设置 AUDIO_DEVICE_NAME/AUDIO_DEVICE_INDEX，将尝试默认音频输入。")
    print(raw_list)
    return ":default"


def record_audio(job_dir: Path, seconds: int) -> Path:
    device = os.getenv("AUDIO_DEVICE_NAME", "BlackHole 2ch")
    audio_input = resolve_audio_input(device)
    raw_path = job_dir / "recording.m4a"
    wav_path = job_dir / "recording.wav"

    print(f"[record] 开始录音：device={device}, seconds={seconds}")
    try:
        result = run([
            "ffmpeg",
            "-y",
            "-f", "avfoundation",
            "-i", audio_input,
            "-t", str(seconds),
            "-ac", "1",
            "-ar", "16000",
            str(raw_path),
        ])
        if result.stderr:
            print(result.stderr)
    except subprocess.CalledProcessError as error:
        stderr = error.stderr or ""
        invalid_index = "Invalid audio device index" in stderr
        suggested_command = 'AUDIO_DEVICE_NAME="BlackHole 2ch" npm run test:audio'
        message = (
            f"检测到 Invalid audio device index。请改用 AUDIO_DEVICE_NAME，并运行：{suggested_command}"
            if invalid_index
            else "录音设备打不开。请检查运行 npm 的 Terminal/Codex 是否有 macOS 麦克风权限，并确认 AUDIO_DEVICE_NAME 是否正确。"
        )
        failure_report = {
            "audio_path": str(wav_path),
            "duration_seconds": None,
            "file_size_bytes": 0,
            "mean_volume_db": None,
            "max_volume_db": None,
            "is_probably_silent": True,
            "recording_failed": True,
            "message": message,
            "suggested_command": suggested_command if invalid_index else None,
            "ffmpeg_stderr": stderr,
        }
        (job_dir / "audio_report.json").write_text(
            json.dumps(failure_report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[record] {failure_report['message']}")
        if stderr.strip():
            print("[record] ffmpeg 原始错误：")
            print(stderr.strip())
        print(f"[record] 报告已生成：{job_dir / 'audio_report.json'}")
        raise

    print("[record] 录音结束，开始转换 wav")
    convert_result = run([
        "ffmpeg",
        "-y",
        "-i", str(raw_path),
        "-ac", "1",
        "-ar", "16000",
        str(wav_path),
    ])
    if convert_result.stderr:
        print(convert_result.stderr)

    print(f"[record] wav 已生成：{wav_path}")
    return wav_path


def parse_volume(stderr: str):
    mean_match = re.search(r"mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?) dB", stderr)
    max_match = re.search(r"max_volume:\s*(-?inf|-?\d+(?:\.\d+)?) dB", stderr)

    def as_float(value):
        if value is None:
            return None
        if value == "-inf":
            return float("-inf")
        return float(value)

    return {
        "mean_volume_db": as_float(mean_match.group(1) if mean_match else None),
        "max_volume_db": as_float(max_match.group(1) if max_match else None),
    }


def probe_duration(audio_path: Path):
    stdout, _ = run_capture([
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(audio_path),
    ])
    try:
        return float(stdout.strip())
    except ValueError:
        return None


def analyze_audio(audio_path: Path, job_dir: Path):
    print("[audio-check] 开始检测音频有效性")
    _, stderr = run_capture([
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i", str(audio_path),
        "-af", "volumedetect",
        "-f", "null",
        "-",
    ])

    volume = parse_volume(stderr)
    duration = probe_duration(audio_path)
    file_size = audio_path.stat().st_size if audio_path.exists() else 0
    max_volume = volume["max_volume_db"]

    is_probably_silent = (
        file_size < 20_000
        or max_volume is None
        or max_volume == float("-inf")
        or max_volume < -45
    )

    report = {
        "audio_path": str(audio_path),
        "duration_seconds": duration,
        "file_size_bytes": file_size,
        "mean_volume_db": volume["mean_volume_db"],
        "max_volume_db": max_volume,
        "is_probably_silent": is_probably_silent,
        "silence_threshold_max_volume_db": -45,
        "message": (
            "录音可能是静音，请检查 macOS 输出设备是否路由到 BlackHole 2ch。"
            if is_probably_silent
            else "录音检测通过，音频里有可见声量。"
        ),
    }

    report_path = job_dir / "audio_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[audio-check] duration={duration}s, size={file_size} bytes, "
          f"mean={volume['mean_volume_db']} dB, max={max_volume} dB")
    print(f"[audio-check] {report['message']}")
    print(f"[audio-check] 报告已生成：{report_path}")

    return report


def write_audio_diagnostic_transcripts(title: str, job_dir: Path, report: dict):
    raw_path = job_dir / "transcript_raw.md"
    clean_path = job_dir / "transcript_clean.md"

    raw = f"""# 原始逐字稿

- status: no_transcript
- reason: BlackHole 录音接近静音，未进入 Whisper 转写
- duration: {report.get("duration_seconds")} seconds
- mean_volume_db: {report.get("mean_volume_db")}
- max_volume_db: {report.get("max_volume_db")}
- audio_report: {job_dir / "audio_report.json"}
"""

    clean = f"""# {title}

## 核心观点

本次没有进入 Whisper 转写，因为录音检测显示 BlackHole 2ch 收到的声音接近静音。

这不是 Whisper 问题，也不是 LLM 清洗问题；当前卡点是 macOS 系统声音没有进入 BlackHole。

## 分章节摘要

暂无。请先让 `audio_report.json` 里的 `is_probably_silent` 变成 `false`。

## 关键案例

暂无。

## 可执行动作

- 打开“系统设置” -> “声音” -> “输出”，选择“多输出设备”。
- 确认“音频 MIDI 设置”里的多输出设备包含 MacBook Air 扬声器 + BlackHole 2ch。
- 确认小鹅通页面正在播放，并且你自己能听到声音。
- 先跑 `AUDIO_DEVICE_NAME="BlackHole 2ch" npm run test:audio`。
- 只有 `is_probably_silent=false` 后，再跑完整 MVP。

## 对我做 AI 操盘手 / 内容 IP / token 现金流 / 知识库系统的启发

这条自动化链路现在不是卡在模型，而是卡在采集入口。先把声音采集校准好，后面转写、清洗、飞书入库才有意义。

## 原始逐字稿

本次未生成逐字稿。

音频报告：

```json
{json.dumps(report, ensure_ascii=False, indent=2)}
```
"""

    raw_path.write_text(raw, encoding="utf-8")
    clean_path.write_text(clean, encoding="utf-8")
    print(f"[audio-check] 已生成诊断逐字稿：{raw_path}")
    print(f"[audio-check] 已生成诊断清洗稿：{clean_path}")


def transcribe_local(audio_path: Path, job_dir: Path):
    from faster_whisper import WhisperModel

    model_name = os.getenv("WHISPER_MODEL", "small")
    print(f"[transcribe] 开始本地转写：model={model_name}")
    model = WhisperModel(model_name, device="auto", compute_type="auto")
    segments, info = model.transcribe(
        str(audio_path),
        language="zh",
        vad_filter=True,
        beam_size=5,
    )

    raw_path = job_dir / "transcript_raw.md"
    with raw_path.open("w", encoding="utf-8") as f:
        f.write(f"# 原始逐字稿\n\n")
        f.write(f"- language: {info.language}\n")
        f.write(f"- duration: {round(info.duration, 2)} seconds\n\n")
        for seg in segments:
            start = round(seg.start, 2)
            end = round(seg.end, 2)
            f.write(f"[{start} - {end}] {seg.text.strip()}\n\n")
    print(f"[transcribe] 转写完成：{raw_path}")


def transcribe_openai(audio_path: Path, job_dir: Path):
    from openai import OpenAI

    print("[transcribe] 开始 OpenAI Whisper API 转写")
    client = OpenAI()
    with audio_path.open("rb") as audio_file:
        result = client.audio.transcriptions.create(
            model=os.getenv("OPENAI_WHISPER_MODEL", "whisper-1"),
            file=audio_file,
            language="zh",
            response_format="text",
        )

    (job_dir / "transcript_raw.md").write_text(
        "# 原始逐字稿\n\n" + str(result),
        encoding="utf-8",
    )
    print(f"[transcribe] 转写完成：{job_dir / 'transcript_raw.md'}")


def get_nested_value(data, path: str):
    current = data
    for part in path.split("."):
        if part == "":
            continue
        if isinstance(current, list):
            current = current[int(part)]
        elif isinstance(current, dict):
            current = current[part]
        else:
            raise KeyError(path)
    return current


def extract_transcript_text(data):
    configured_path = os.getenv("VOLCENGINE_ASR_TEXT_PATH", "").strip()
    candidate_paths = [
        configured_path,
        "text",
        "result.text",
        "result.result.0.text",
        "result.0.text",
        "utterances.0.text",
        "data.text",
        "data.result.text",
    ]
    for path in candidate_paths:
        if not path:
            continue
        try:
            value = get_nested_value(data, path)
            if isinstance(value, str) and value.strip():
                return value.strip()
        except Exception:
            continue
    return json.dumps(data, ensure_ascii=False, indent=2)


def volcengine_headers():
    headers = {}
    auth_header = os.getenv("VOLCENGINE_ASR_AUTH_HEADER", "Authorization").strip()
    token = os.getenv("VOLCENGINE_ASR_TOKEN", "").strip()
    if token:
        prefix = os.getenv("VOLCENGINE_ASR_AUTH_PREFIX", "Bearer").strip()
        headers[auth_header] = f"{prefix} {token}".strip()

    app_id = os.getenv("VOLCENGINE_ASR_APP_ID", "").strip()
    if app_id:
        headers["X-Api-App-Id"] = app_id

    extra_headers = os.getenv("VOLCENGINE_ASR_HEADERS_JSON", "").strip()
    if extra_headers:
        headers.update(json.loads(extra_headers))
    return headers


def post_json(url: str, headers: dict, payload: dict):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=int(os.getenv("VOLCENGINE_ASR_TIMEOUT", "180"))) as response:
        return json.loads(response.read().decode("utf-8"))


def post_multipart(url: str, headers: dict, audio_path: Path):
    boundary = f"----xiaoe-asr-{uuid.uuid4().hex}"
    file_field = os.getenv("VOLCENGINE_ASR_FILE_FIELD", "file")
    fields = {}
    fields_json = os.getenv("VOLCENGINE_ASR_FIELDS_JSON", "").strip()
    if fields_json:
        fields.update(json.loads(fields_json))

    chunks = []
    for key, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{audio_path.name}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
        .encode("utf-8")
    )
    chunks.append(audio_path.read_bytes())
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))

    req = request.Request(
        url,
        data=b"".join(chunks),
        headers={**headers, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with request.urlopen(req, timeout=int(os.getenv("VOLCENGINE_ASR_TIMEOUT", "180"))) as response:
        return json.loads(response.read().decode("utf-8"))


def transcribe_volcengine(audio_path: Path, job_dir: Path):
    url = os.getenv("VOLCENGINE_ASR_URL", "").strip()
    if not url:
        raise RuntimeError("TRANSCRIBE_PROVIDER=volcengine 但缺少 VOLCENGINE_ASR_URL")

    request_format = os.getenv("VOLCENGINE_ASR_REQUEST_FORMAT", "multipart").strip()
    headers = volcengine_headers()
    print(f"[transcribe] 开始火山 ASR 转写：format={request_format}")

    if request_format == "json_base64":
        payload = {}
        payload_json = os.getenv("VOLCENGINE_ASR_PAYLOAD_JSON", "").strip()
        if payload_json:
            payload.update(json.loads(payload_json))
        payload[os.getenv("VOLCENGINE_ASR_AUDIO_FIELD", "audio")] = base64.b64encode(audio_path.read_bytes()).decode("ascii")
        payload[os.getenv("VOLCENGINE_ASR_AUDIO_FORMAT_FIELD", "format")] = os.getenv("VOLCENGINE_ASR_AUDIO_FORMAT", "wav")
        result = post_json(url, headers, payload)
    else:
        result = post_multipart(url, headers, audio_path)

    text = extract_transcript_text(result)
    raw_path = job_dir / "transcript_raw.md"
    raw_path.write_text(
        "# 原始逐字稿\n\n"
        "- provider: volcengine\n\n"
        f"{text}\n",
        encoding="utf-8",
    )
    (job_dir / "volcengine_asr_response.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[transcribe] 转写完成：{raw_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", required=True)
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--seconds", type=int, default=5400)
    parser.add_argument("--audio-test-only", action="store_true")
    args = parser.parse_args()

    job_dir = Path(args.job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)

    audio_path = record_audio(job_dir, args.seconds)
    report = analyze_audio(audio_path, job_dir)

    if args.audio_test_only:
        print("[audio-test] 只做音频测试，跳过转写")
        return

    if report["is_probably_silent"]:
        write_audio_diagnostic_transcripts(args.title, job_dir, report)
        raise RuntimeError("录音可能是静音。已停止 Whisper 和 LLM；这不是 Whisper 问题，而是 BlackHole 没收到声音。")

    provider = os.getenv("TRANSCRIBE_PROVIDER", "local")
    if provider == "openai":
        transcribe_openai(audio_path, job_dir)
    elif provider == "volcengine":
        transcribe_volcengine(audio_path, job_dir)
    else:
        transcribe_local(audio_path, job_dir)


if __name__ == "__main__":
    main()
