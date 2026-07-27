"""Generate example events.csv and matching WAV clips for local dev/testing.

Run from the repo root:

    .venv/Scripts/python web/scripts/generate_example_data.py

Writes web/public/example.csv and web/public/recordings/<date>/<file>.wav.
The CSV matches the exact format written by bark_detector.save_event():
  started_at_utc,ended_at_utc,duration_seconds,peak_confidence,audio_path,level_dbfs
where timestamps are datetime.now(timezone.utc).isoformat() (6-digit micros,
"+00:00") and audio_path is relative ("recordings/DATE/FILE.wav"). Older
events.csv files written before the level_dbfs column exist have only the
first five fields; the dashboard parser accepts both shapes.
"""
from __future__ import annotations

import csv
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

ANALYSIS_RATE = 16_000
DAYS = 7
SEED = 42

HERE = Path(__file__).resolve().parent
PUBLIC_DIR = HERE.parent / "public"
RECORDINGS_DIR = PUBLIC_DIR / "recordings"
EXAMPLE_CSV = PUBLIC_DIR / "example.csv"


def make_bark_audio(duration: float, rng: np.random.Generator) -> np.ndarray:
    """A few short woof-like bursts over a noise floor, ~duration seconds long."""
    n = int(round(duration * ANALYSIS_RATE))
    signal = np.zeros(n, dtype=np.float32)

    woofs = int(rng.integers(2, 6))
    for _ in range(woofs):
        start = float(rng.uniform(0.0, max(0.01, duration - 0.25)))
        length = float(rng.uniform(0.08, 0.18))
        freq = float(rng.uniform(350, 850))
        idx0 = int(start * ANALYSIS_RATE)
        idx1 = min(n, idx0 + max(1, int(length * ANALYSIS_RATE)))
        local_t = np.arange(idx1 - idx0) / ANALYSIS_RATE
        envelope = np.exp(-((local_t - length / 2) / (length / 3)) ** 2)
        signal[idx0:idx1] += (
            envelope * np.sin(2 * math.pi * freq * local_t)
        ).astype(np.float32)

    signal += (0.03 * rng.standard_normal(n)).astype(np.float32)
    peak = float(np.max(np.abs(signal)))
    if peak > 0.9:
        signal *= 0.9 / peak
    return signal


def peak_dbfs(audio: np.ndarray) -> float:
    """Peak level in dBFS; mirrors bark_detector.peak_dbfs."""
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    return -120.0 if peak <= 0.0 else 20.0 * math.log10(peak)


def main() -> None:
    rng = random.Random(SEED)
    nrng = np.random.default_rng(SEED)
    now = datetime.now(timezone.utc)

    events: list[tuple[datetime, float, float]] = []
    for day_offset in range(DAYS):
        day = now - timedelta(days=day_offset)
        count = rng.randint(3, 11)  # some days are busier than others
        for _ in range(count):
            started = day.replace(
                hour=rng.randint(6, 21),
                minute=rng.randint(0, 59),
                second=rng.randint(0, 59),
                microsecond=rng.randint(0, 999_999),
                tzinfo=timezone.utc,
            )
            duration = round(rng.uniform(0.5, 6.0), 2)
            confidence = round(rng.uniform(0.20, 0.95), 3)
            events.append((started, duration, confidence))

    events.sort(key=lambda item: item[0])

    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    with EXAMPLE_CSV.open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(
            [
                "started_at_utc",
                "ended_at_utc",
                "duration_seconds",
                "peak_confidence",
                "audio_path",
                "level_dbfs",
            ]
        )
        for started, duration, confidence in events:
            ended = started + timedelta(seconds=duration)
            day_str = started.strftime("%Y-%m-%d")
            filename = started.strftime("%Y-%m-%dT%H-%M-%S.%fZ.wav")
            audio_path = f"recordings/{day_str}/{filename}"
            wav_path = PUBLIC_DIR / audio_path
            wav_path.parent.mkdir(parents=True, exist_ok=True)
            signal = make_bark_audio(duration, nrng)
            sf.write(
                wav_path,
                signal,
                ANALYSIS_RATE,
                subtype="PCM_16",
            )
            writer.writerow(
                [
                    started.isoformat(),
                    ended.isoformat(),
                    f"{duration:.2f}",
                    f"{confidence:.3f}",
                    audio_path,
                    f"{peak_dbfs(signal):.1f}",
                ]
            )

    print(
        f"Wrote {EXAMPLE_CSV.relative_to(HERE.parent.parent)} "
        f"({len(events)} events) and WAVs under "
        f"{RECORDINGS_DIR.relative_to(HERE.parent.parent)}"
    )


if __name__ == "__main__":
    main()
