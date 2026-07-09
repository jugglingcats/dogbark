from __future__ import annotations

import argparse
import csv
import queue
import sys
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf
import tensorflow_hub as hub
from scipy.signal import resample_poly


ANALYSIS_RATE = 16_000
HOP_SECONDS = 0.5
WINDOW_SECONDS = 1.0

PRE_ROLL_SECONDS = 2.0
POST_ROLL_SECONDS = 3.0
MIN_CONSECUTIVE_HITS = 2
DEFAULT_THRESHOLD = 0.20

# Add "Dog" if genuine barks are regularly missed, though it may increase
# false positives.
BARK_LABELS = {
    "Bark",
    "Bow-wow",
    "Yip",
    "Dog",
    "Canidae, dogs, wolves",
    "Domestic animals, pets"
}

MODEL_URL = "https://tfhub.dev/google/yamnet/1"
RECORDINGS_DIR = Path("recordings")
EVENTS_CSV = Path("events.csv")

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Detect and record dog barking."
    )
    parser.add_argument(
        "--device",
        help="Input device number or name. Defaults to the system input.",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD,
        help=f"Bark confidence threshold; default {DEFAULT_THRESHOLD}.",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List audio devices and exit.",
    )
    parser.add_argument(
        "--show-top",
        action="store_true",
        help="Continuously show the model's top classification.",
    )
    parser.add_argument(
        "--list-classes",
        action="store_true",
        help="List YAMNet class names and exit.",
    )
    return parser.parse_args()


def load_class_names(model) -> list[str]:
    class_map_path = model.class_map_path().numpy().decode("utf-8")

    with open(class_map_path, newline="", encoding="utf-8") as file:
        rows = csv.DictReader(file)
        return [row["display_name"] for row in rows]


def save_event(
    chunks: list[np.ndarray],
    started_at: datetime,
    peak_confidence: float,
) -> None:
    if not chunks:
        return

    audio = np.concatenate(chunks)
    duration = len(audio) / ANALYSIS_RATE
    ended_at = started_at + timedelta(seconds=duration)

    day_dir = RECORDINGS_DIR / started_at.strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)

    filename = started_at.strftime("%Y-%m-%dT%H-%M-%S.%fZ.wav")
    audio_path = day_dir / filename

    sf.write(
        audio_path,
        audio,
        ANALYSIS_RATE,
        subtype="PCM_16",
    )

    new_csv = not EVENTS_CSV.exists()

    with EVENTS_CSV.open("a", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)

        if new_csv:
            writer.writerow(
                [
                    "started_at_utc",
                    "ended_at_utc",
                    "duration_seconds",
                    "peak_confidence",
                    "audio_path",
                ]
            )

        writer.writerow(
            [
                started_at.isoformat(),
                ended_at.isoformat(),
                f"{duration:.2f}",
                f"{peak_confidence:.3f}",
                str(audio_path),
            ]
        )

    print(
        f"\nSaved {audio_path} "
        f"({duration:.1f}s, peak {peak_confidence:.2f})"
    )


def main() -> None:
    args = parse_args()

    if args.list_devices:
        print(sd.query_devices())
        return

    device: int | str | None = args.device

    if isinstance(device, str) and device.isdigit():
        device = int(device)

    print("Loading YAMNet. The first run downloads the model...")
    model = hub.load(MODEL_URL)
    class_names = load_class_names(model)

    if args.list_classes:
        for name in class_names:
            print(name)
        return

    bark_indexes = [
        index
        for index, name in enumerate(class_names)
        if name in BARK_LABELS
    ]

    if not bark_indexes:
        raise RuntimeError(
            f"No configured labels found: {sorted(BARK_LABELS)}"
        )

    if len(bark_indexes) != len(BARK_LABELS):
        raise RuntimeError(
            f"Expected {len(BARK_LABELS)} labels, found {len(bark_indexes)}"
        )

    print(
        "Watching for: "
        + ", ".join(class_names[index] for index in bark_indexes)
    )

    device_info = sd.query_devices(device, "input")
    input_rate = int(round(device_info["default_samplerate"]))
    input_hop_samples = int(input_rate * HOP_SECONDS)
    window_samples = int(ANALYSIS_RATE * WINDOW_SECONDS)

    print(
        f"Input: {device_info['name']} at {input_rate} Hz; "
        f"analysis at {ANALYSIS_RATE} Hz"
    )

    pre_roll_chunk_count = max(
        1,
        round(PRE_ROLL_SECONDS / HOP_SECONDS),
    )

    audio_queue: queue.Queue[np.ndarray] = queue.Queue(maxsize=20)

    analysis_buffer: deque[np.ndarray] = deque(
        maxlen=max(1, round(WINDOW_SECONDS / HOP_SECONDS))
    )

    pre_roll: deque[np.ndarray] = deque(
        maxlen=pre_roll_chunk_count
    )

    active = False
    consecutive_hits = 0
    last_hit_time = 0.0

    event_chunks: list[np.ndarray] = []
    event_started_at: datetime | None = None
    event_peak_confidence = 0.0

    def audio_callback(
        indata: np.ndarray,
        frames: int,
        time_info,
        status,
    ) -> None:
        if status:
            print(f"\nAudio warning: {status}", file=sys.stderr)

        mono = indata[:, 0].copy()

        try:
            audio_queue.put_nowait(mono)
        except queue.Full:
            print(
                "\nAudio queue overflow; dropping a block.",
                file=sys.stderr,
            )

    try:
        with sd.InputStream(
            device=device,
            samplerate=input_rate,
            channels=1,
            dtype="float32",
            blocksize=input_hop_samples,
            callback=audio_callback,
        ):
            print("Listening. Press Ctrl+C to stop.")

            while True:
                input_chunk = audio_queue.get()

                if input_rate == ANALYSIS_RATE:
                    chunk = input_chunk
                else:
                    chunk = resample_poly(
                        input_chunk,
                        ANALYSIS_RATE,
                        input_rate,
                    ).astype(np.float32)

                now_monotonic = time.monotonic()
                now_utc = datetime.now(timezone.utc)

                analysis_buffer.append(chunk)
                pre_roll.append(chunk)

                if active:
                    event_chunks.append(chunk.copy())

                available_samples = sum(
                    len(item) for item in analysis_buffer
                )

                if available_samples < window_samples:
                    continue

                waveform = np.concatenate(analysis_buffer)
                waveform = waveform[-window_samples:]

                scores, _, _ = model(waveform)
                mean_scores = np.mean(scores.numpy(), axis=0)

                bark_confidence = float(
                    np.max(mean_scores[bark_indexes])
                )

                top_index = int(np.argmax(mean_scores))

                if args.show_top:
                    print(
                        f"\rTop: {class_names[top_index]:<30} "
                        f"{mean_scores[top_index]:.2f} | "
                        f"bark {bark_confidence:.2f}",
                        end="",
                        flush=True,
                    )

                detected = bark_confidence >= args.threshold

                if detected:
                    consecutive_hits += 1
                    last_hit_time = now_monotonic
                else:
                    consecutive_hits = 0

                if (
                    not active
                    and consecutive_hits >= MIN_CONSECUTIVE_HITS
                ):
                    active = True
                    event_chunks = [
                        item.copy() for item in pre_roll
                    ]

                    buffered_seconds = (
                        sum(len(item) for item in event_chunks)
                        / ANALYSIS_RATE
                    )

                    event_started_at = now_utc - timedelta(
                        seconds=buffered_seconds
                    )
                    event_peak_confidence = bark_confidence

                    local_time = now_utc.astimezone().isoformat(
                        timespec="seconds"
                    )

                    print(
                        f"\nBark detected at {local_time} "
                        f"(confidence {bark_confidence:.2f})"
                    )

                if active:
                    event_peak_confidence = max(
                        event_peak_confidence,
                        bark_confidence,
                    )

                    silence_duration = (
                        now_monotonic - last_hit_time
                    )

                    if silence_duration >= POST_ROLL_SECONDS:
                        assert event_started_at is not None

                        save_event(
                            event_chunks,
                            event_started_at,
                            event_peak_confidence,
                        )

                        active = False
                        consecutive_hits = 0
                        event_chunks = []
                        event_started_at = None
                        event_peak_confidence = 0.0

    except KeyboardInterrupt:
        print("\nStopping.")

        if active and event_started_at is not None:
            save_event(
                event_chunks,
                event_started_at,
                event_peak_confidence,
            )


if __name__ == "__main__":
    main()