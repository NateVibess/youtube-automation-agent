#!/usr/bin/env python3
"""Transcribe a media file locally with faster-whisper and write word-level JSON.

Usage: python3 scripts/clips/transcribe.py INPUT OUTPUT.json [--model small.en]
"""
import argparse
import json
import subprocess
import sys
import time

import numpy as np
from faster_whisper import WhisperModel


def load_audio(path):
    # Decode with ffmpeg rather than faster-whisper's PyAV path, which breaks on mismatched av versions.
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args()

    started = time.time()
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads)
    segments, info = model.transcribe(
        load_audio(args.input),
        language="en",
        word_timestamps=True,
        vad_filter=True,
        beam_size=1,
    )

    result = {"language": info.language, "duration": info.duration, "segments": []}
    for segment in segments:
        result["segments"].append({
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip(),
            "words": [
                {"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word.strip()}
                for w in (segment.words or [])
            ],
        })
        print(f"[{segment.start:7.1f}] {segment.text.strip()[:90]}", file=sys.stderr, flush=True)

    with open(args.output, "w") as handle:
        json.dump(result, handle)
    print(f"done in {time.time() - started:.0f}s, {len(result['segments'])} segments", file=sys.stderr)


if __name__ == "__main__":
    main()
