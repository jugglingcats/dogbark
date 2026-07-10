# dogbark

Detect and record dog barking with [YAMNet](https://tfhub.dev/google/yamnet/1), then view the detections in a built-in web dashboard.

`bark_detector.py` listens to a microphone, runs YAMNet over a sliding 1-second audio window, and on each bark event records a WAV clip and appends a row to `events.csv`. The same process also serves a small React dashboard (the built `web/` app) over HTTP, so you can browse detections and play back recordings from any browser.

## How it works

- **Detection** runs continuously on the main thread, writing `recordings/YYYY-MM-DD/<timestamp>.wav` and appending to `events.csv`.
- **Web dashboard** runs on a background thread in the same process, serving:
  - the built SPA at `/`
  - the live log at `/events.csv`
  - recorded audio at `/recordings/...` (with byte-range support for seeking)

## Prerequisites (Raspberry Pi)

1. **Python 3.13.5+** and the detector dependencies, plus a USB microphone:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -e .
   ```
2. **Node.js ≥ 22.12** and **pnpm**, to build the dashboard (below).

## Build the webapp

The dashboard is a Vite + React + TypeScript + Tailwind app in `web/`. Build it once on the Pi (or build elsewhere and copy `web/dist/` over):

```bash
# 1. Node.js (pick one):
#    Option A — NodeSource APT repo:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
#    Option B — nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 22
node -v   # must be >= 22.12

# 2. pnpm via corepack (bundled with Node):
corepack enable
corepack prepare pnpm@latest --activate

# 3. install + build:
cd web
pnpm install
pnpm build      # outputs web/dist/
```

> Tailwind is v4 via the `@tailwindcss/vite` plugin — there is intentionally **no** `tailwind.config.js` or PostCSS config.

## Run

From the repo root (with the venv active):

```bash
python bark_detector.py                 # detection + dashboard on :8000
python bark_detector.py --port 8080     # custom dashboard port
python bark_detector.py --device 2      # specific input device
python bark_detector.py --no-web        # detection only, no dashboard
python bark_detector.py --list-devices  # find your --device index
```

Open `http://<pi-ip>:8000` in a browser. The dashboard shows barks-per-day and confidence charts, a sortable event table, and per-event audio playback; it auto-refreshes every ~20s.

## Develop the dashboard locally (no detector needed)

```bash
cd web
pnpm install     # first time
pnpm dev         # http://localhost:5173, reads web/public/example.csv
```

`web/public/example.csv` and `web/public/recordings/` are committed example data (52 events over a week) so the UI is testable without a microphone. Regenerate them with:

```bash
python web/scripts/generate_example_data.py
```

## Remote access (outside your home)

`scripts/tunnel.sh` starts a Cloudflare Tunnel — no port forwarding or public IP needed. It prints a public `https://*.trycloudflare.com` URL:

```bash
bash scripts/tunnel.sh         # quick tunnel to port 8000
bash scripts/tunnel.sh 8080    # custom port
```

> ⚠️ **Security — read this before you share the URL.** The dashboard has **no authentication**. Anyone who learns the tunnel URL can see your full bark log (the timestamps reveal when you are/aren't home) **and play back audio recordings of your home**. The quick-tunnel URL is random and changes on every restart, which is only weak protection. For ongoing use, set up a **named tunnel behind Cloudflare Access** (email/Google login) — `scripts/tunnel.sh` contains step-by-step comments for both the named tunnel and a systemd unit to keep it alive across reboots.

## Troubleshooting

- **"Webapp not built" page** — run `cd web && pnpm install && pnpm build`, then restart the detector.
- **Blank page after a rebuild** — a stale cached `index.html` is referencing old asset files. Hard-refresh the browser (the server already sends `Cache-Control: no-cache` for the shell).
- **Audio won't play** — recordings are served under `/recordings/...`; check the browser console for 404s (the event must reference a file that exists).
- **No data on a fresh Pi** — with zero barks, `/events.csv` 404s and the dashboard shows "No barks recorded yet."
