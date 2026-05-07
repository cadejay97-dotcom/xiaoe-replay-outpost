import argparse
import os
from pathlib import Path

from dotenv import load_dotenv

from record_transcribe import transcribe_local, transcribe_openai, transcribe_volcengine

load_dotenv()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True)
    args = parser.parse_args()

    job_dir = Path(args.job_dir)
    audio_path = job_dir / "recording.wav"
    if not audio_path.exists():
        raise FileNotFoundError(f"recording.wav not found: {audio_path}")

    provider = os.getenv("TRANSCRIBE_PROVIDER", "local")
    if provider == "openai":
        transcribe_openai(audio_path, job_dir)
    elif provider == "volcengine":
        transcribe_volcengine(audio_path, job_dir)
    else:
        transcribe_local(audio_path, job_dir)


if __name__ == "__main__":
    main()
