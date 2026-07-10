from __future__ import annotations

import argparse
import csv
import http.server
import mimetypes
import os
import queue
import sys
import threading
import time
import urllib.parse
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

DEFAULT_PORT = 8000
WEB_DIST = Path(__file__).resolve().parent / "web" / "dist"

NOT_BUILT_HTML = """<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Dog Bark Monitor</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; line-height: 1.5">
    <h1>🐶 Webapp not built</h1>
    <p>The detector is running, but the web dashboard hasn't been built yet.</p>
    <p>Build it with:</p>
    <pre style="background: #f4f4f5; padding: 0.75rem; border-radius: 0.25rem">cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</pre>
    <p>Then restart the detector.</p>
  </body>
</html>
"""

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
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Port for the web dashboard; default {DEFAULT_PORT}.",
    )
    parser.add_argument(
        "--no-web",
        action="store_true",
        help="Do not start the web dashboard server.",
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


# --- Web dashboard ---------------------------------------------------------
# Register MIME types a minimal OS image may not know. Without these the SPA's
# ES modules are served as application/octet-stream and the page stays blank.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("audio/wav", ".wav")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")


class BarkHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the built dashboard, the live events.csv, and recorded audio."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIST), **kwargs)

    def do_GET(self):
        url_path = urllib.parse.urlparse(self.path).path
        is_data_route = (
            url_path == "/events.csv" or url_path.startswith("/recordings")
        )
        if not WEB_DIST.exists() and not is_data_route:
            self._respond_html(NOT_BUILT_HTML)
            return
        super().do_GET()

    def translate_path(self, path):
        url_path = urllib.parse.unquote(urllib.parse.urlparse(path).path)

        if url_path == "/events.csv":
            return str(EVENTS_CSV.resolve())

        if url_path.startswith("/recordings/"):
            root = RECORDINGS_DIR.resolve()
            target = (root / url_path[len("/recordings/"):]).resolve()
            if target.is_relative_to(root):
                return str(target)
            return str(root / "__blocked__")  # path traversal → 404

        filesystem_path = super().translate_path(path)
        # SPA fallback: an unknown route with no file extension serves index.html.
        if not os.path.exists(filesystem_path):
            last_segment = url_path.rstrip("/").rsplit("/", 1)[-1]
            if last_segment and "." not in last_segment:
                return os.path.join(str(WEB_DIST), "index.html")
        return filesystem_path

    def send_head(self):
        # Add HTTP Range support (Python's SimpleHTTPRequestHandler lacks it).
        # <audio> seeks via Range; Safari in particular insists on 206 responses.
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()  # directories, index.html listing, 404s

        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()  # normal full-content GET/HEAD, 304, etc.

        try:
            stat = os.stat(path)
        except OSError:
            return self.send_error(404, "Not found")

        start, end = self._parse_range(range_header, stat.st_size)
        if start is None:
            return super().send_head()  # malformed Range → serve full content

        end = min(end, stat.st_size - 1)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{stat.st_size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.end_headers()
        if self.command != "HEAD":
            with open(path, "rb") as handle:
                handle.seek(start)
                self.wfile.write(handle.read(end - start + 1))
        return None

    @staticmethod
    def _parse_range(header, size):
        """Parse a "bytes=..." Range header into (start, end) inclusive, or
        (None, None) if absent/malformed. end may exceed size; the caller clamps."""
        try:
            unit, spec = header.split("=", 1)
            if unit.strip() != "bytes":
                return None, None
            start_str, end_str = spec.split("-", 1)
            if start_str:
                start = int(start_str)
                end = int(end_str) if end_str else size - 1
            else:
                # suffix range: last N bytes
                start = max(0, size - int(end_str))
                end = size - 1
            if start > end or start >= size:
                return None, None
            return start, end
        except (ValueError, AttributeError):
            return None, None

    def end_headers(self):
        url_path = urllib.parse.urlparse(self.path).path
        last_segment = url_path.rsplit("/", 1)[-1]
        is_html = url_path == "/" or url_path.endswith(".html") or (
            last_segment and "." not in last_segment
        )
        # Never cache the SPA shell or the live CSV; hashed assets cache fine.
        if is_html or url_path == "/events.csv":
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _respond_html(self, body):
        encoded = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt, *args):
        sys.stderr.write("[web] %s - %s\n" % (self.address_string(), fmt % args))


def start_web_server(port):
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), BarkHandler)
    thread = threading.Thread(
        target=httpd.serve_forever, daemon=True, name="dogbark-web"
    )
    thread.start()
    print(
        f"Serving dashboard at http://localhost:{port}/ "
        f"(also /events.csv and /recordings/)"
    )
    return httpd


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

    httpd = None
    if not args.no_web:
        try:
            httpd = start_web_server(args.port)
        except OSError as exc:
            print(f"Could not start web dashboard: {exc}", file=sys.stderr)

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

        if httpd is not None:
            httpd.shutdown()

        if active and event_started_at is not None:
            save_event(
                event_chunks,
                event_started_at,
                event_peak_confidence,
            )


if __name__ == "__main__":
    main()