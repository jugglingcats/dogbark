# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`dogbark` is a CLI tool that listens to a microphone, runs the YAMNet audio-classification model (from TensorFlow Hub) over a sliding window, and records WAV clips plus a CSV log whenever dog barking is detected. It also serves a built web dashboard (Vite + React + TS in `web/`) over HTTP from a background thread, so detections can be browsed and recordings played back in a browser. The detector logic lives in `bark_detector.py` (~470 lines); the detector itself has no build step beyond `pip install`, but the webapp is built with pnpm (`cd web && pnpm build`).

## Commands

The project uses a local virtualenv at `.venv` (Python 3.13.x). On Windows, invoke the interpreter at `.venv/Scripts/python.exe`.

```bash
# Install dependencies (first time only)
pip install -e .

# Run detection (first run downloads YAMNet from tfhub.dev, then caches it)
python bark_detector.py

# Pick a specific input device, or tune sensitivity
python bark_detector.py --device 2 --threshold 0.20

# Introspection helpers (exit immediately, no microphone needed)
python bark_detector.py --list-devices    # show PortAudio input devices
python bark_detector.py --list-classes    # print YAMNet class names (needs model load)
python bark_detector.py --show-top        # continuous top-1 + bark confidence overlay

# Web dashboard (served by the detector on a background thread, port 8000)
python bark_detector.py --port 8080       # custom dashboard port
python bark_detector.py --no-web          # detection only, no dashboard

# Webapp (Vite + React + TS + Tailwind, in web/)
cd web && pnpm install && pnpm build      # build to web/dist/ (served by the detector)
cd web && pnpm dev                        # dev server at :5173, reads web/public/example.csv
python web/scripts/generate_example_data.py  # regenerate example.csv + example WAVs

# Format (Black is the configured formatter, see .idea/misc.xml)
black bark_detector.py
```

There is no test suite, linter, or CI configured. `--list-devices` is the way to discover the numeric/named `--device` value to pass.

## Architecture

The program is one real-time pipeline with several cooperating pieces inside `main()`. Understanding the data flow matters more than the line-by-line logic:

**Audio capture → queue (separate thread).** `sd.InputStream` calls `audio_callback` on PortAudio's audio thread, which copies the mono channel and pushes it onto a bounded `queue.Queue` (`maxsize=20`; overflows are dropped with a warning). The main thread consumes from this queue, decoupling capture from inference.

**Resampling.** The input device runs at its native sample rate (read from `device_info["default_samplerate"]`); `scipy.signal.resample_poly` converts each hop to `ANALYSIS_RATE` (16 kHz), the only rate YAMNet accepts. If the device already runs at 16 kHz, resampling is skipped.

**Windowed inference.** Resampled hops accumulate in `analysis_buffer` (a `deque`); once ≥ `WINDOW_SECONDS` (1.0 s) of audio is buffered, the last `window_samples` are run through YAMNet. The model returns per-frame class scores; `mean_scores` averages across frames, and `bark_confidence` is the max score over the bark-matching class indexes. This runs every `HOP_SECONDS` (0.5 s).

**Event state machine** (the core logic). Detection is not a single threshold crossing — it's a state machine to avoid noise:
- `MIN_CONSECUTIVE_HITS` (2) consecutive hops above threshold flip `active` to True and **start an event**.
- On start, the `pre_roll` deque (2.0 s of recent audio) is copied in, so clips include the bark that triggered detection. `event_started_at` is back-dated by the buffered length.
- While active, every hop is appended to `event_chunks` and `event_peak_confidence` is tracked up.
- The event ends after `POST_ROLL_SECONDS` (3.0 s) of silence since the last hit, at which point `save_event` fires.

**Persistence.** `save_event` concatenates the event chunks, writes `recordings/YYYY-MM-DD/<ISO-Timestamp>.wav` (PCM_16, 16 kHz), and appends a row to `events.csv` (columns: `started_at_utc, ended_at_utc, duration_seconds, peak_confidence, audio_path`). On Ctrl+C, an in-flight active event is also flushed.

## Webapp

`bark_detector.py` also serves the built dashboard from a daemon background thread (`start_web_server`, a `ThreadingHTTPServer` + `BarkHandler`). Threading is safe because the main thread blocks on the audio queue between inferences and the audio callback is trivial. `BarkHandler` subclasses `SimpleHTTPRequestHandler` (so it inherits streaming/`If-Modified-Since`) with routing via `translate_path`:

- `/` and static assets → `web/dist/`; an unknown route with no file extension falls back to `index.html` (SPA routing).
- `/events.csv` → the live log at the repo root.
- `/recordings/...` → the recordings tree, with a path-traversal guard (`is_relative_to`).

Two stdlib gaps that bit during testing and are worked around in `BarkHandler`: (1) `SimpleHTTPRequestHandler` does **not** support byte-range requests, so `send_head` is overridden to return `206`/`Content-Range` (audio seeking/Safari need it); (2) a minimal Pi image doesn't register MIME for `.js`/`.mjs`, which serves ES modules as `application/octet-stream` and blanks the SPA, so `mimetypes.add_type` is called at module load. If `web/dist/` doesn't exist, non-data routes serve a "not built" page (data routes still work). Flags: `--port` (default 8000), `--no-web`. The server is shut down in the `KeyboardInterrupt` handler.

The frontend (`web/src/`) fetches the CSV and renders Chart.js charts + an events table with `<audio>` playback. Two cross-cutting details:
- **Data source switches on `import.meta.env.DEV`** (`web/src/lib/csv.ts`): dev fetches `/example.csv` (committed test data in `web/public/`), prod fetches `/events.csv` (served by the detector). Recording URLs are identical in both modes (`audioUrlFor` normalizes backslashes → `/recordings/...`).
- **Timestamp normalization**: the writer emits 6-digit microsecond ISO timestamps (`...123456+00:00`), but ECMAScript only allows ≤3 fractional digits, so `parseEvents` truncates before `new Date()`. Any change to the CSV format must keep `parseEvents` and `example.csv` in sync.

`scripts/tunnel.sh` runs a Cloudflare quick tunnel for remote access (random URL, no auth — see the prominent warning in `README.md` and the script header).

## Tunable Constants (top of `bark_detector.py`)

`ANALYSIS_RATE`, `HOP_SECONDS`, `WINDOW_SECONDS`, `PRE_ROLL_SECONDS`, `POST_ROLL_SECONDS`, `MIN_CONSECUTIVE_HITS`, `DEFAULT_THRESHOLD`, and `BARK_LABELS`. The `BARK_LABELS` set is load-bearing: at startup the code maps each label to a YAMNet class index and **raises `RuntimeError` if any label is missing or the count mismatches** — so editing that set requires the labels to exist verbatim in the YAMNet class names. Use `--list-classes` to verify names before changing it.

## Notes

- `events.csv` and the `recordings/` tree (at the repo root) are runtime-generated artifacts and are gitignored. The committed example fixtures live under `web/public/` (`example.csv` + `recordings/`) and are intentionally tracked.
- `classes.txt` is a UTF-16 captured stdout dump of `--list-classes`, not source code.
- Timestamps in filenames and the CSV are UTC (`datetime.now(timezone.utc)`); the console "Bark detected at …" line prints local time.
