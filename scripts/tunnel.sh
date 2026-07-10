#!/usr/bin/env bash
#
# tunnel.sh — expose the dogbark dashboard outside your home firewall using a
# Cloudflare Tunnel (cloudflared). No port forwarding or public IP required.
#
# Usage:
#   bash scripts/tunnel.sh          # quick tunnel to port 8000
#   bash scripts/tunnel.sh 9000     # quick tunnel to a custom port
#
# ⚠️  SECURITY: the dashboard has NO authentication. Anyone who learns the URL
# can read your full bark log (the UTC timestamps reveal when you are home or
# away) and play back audio recordings of your home. The quick-tunnel URL is
# random and changes on every restart, which is only weak protection. Before
# relying on this long-term, put a NAMED tunnel behind Cloudflare Access
# (email/Google OTP) — see "Named tunnel" at the bottom.
#
set -euo pipefail

PORT="${1:-8000}"

# --- ensure cloudflared is installed --------------------------------------
if ! command -v cloudflared >/dev/null 2>&1; then
    arch="$(uname -m)"
    case "$arch" in
        aarch64|arm64) pkg="cloudflared-linux-arm64.deb" ;;  # Pi 3/4/5 (64-bit OS)
        armv7l|armhf)  pkg="cloudflared-linux-armhf.deb" ;;  # Pi Zero/1/2, 32-bit OS
        x86_64)        pkg="cloudflared-linux-amd64.deb" ;;
        *)
            echo "Unsupported architecture '$arch'. Install cloudflared manually:" >&2
            echo "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
            exit 1
            ;;
    esac
    echo "cloudflared is not installed. On Raspberry Pi OS / Debian, run:"
    echo
    echo "  wget https://github.com/cloudflare/cloudflared/releases/latest/download/${pkg}"
    echo "  sudo dpkg -i ${pkg}"
    echo "  sudo apt-get install -f   # installs any missing dependencies"
    echo
    echo "Then re-run this script."
    exit 1
fi

# --- quick tunnel (zero config, random URL) -------------------------------
echo "Starting Cloudflare quick tunnel -> http://localhost:${PORT}"
echo "Look for the https://*.trycloudflare.com URL in cloudflared's output below."
echo "(The URL is random, unauthenticated, and changes on every restart.)"
exec cloudflared tunnel --url "http://localhost:${PORT}"

# --- Keep it alive across reboots (systemd) -------------------------------
# Save as /etc/systemd/system/dogbark-tunnel.service, then:
#   sudo systemctl daemon-reload && sudo systemctl enable --now dogbark-tunnel
#
#   [Unit]
#   Description=Dogbark Cloudflare quick tunnel
#   After=network-online.target
#
#   [Service]
#   ExecStart=/usr/bin/cloudflared tunnel --url http://localhost:8000
#   Restart=on-failure
#
#   [Install]
#   WantedBy=multi-user.target

# --- Named tunnel (stable URL + authentication) --------------------------
# A named tunnel gives a permanent hostname that survives restarts and can be
# protected by Cloudflare Access. One-time setup:
#
#   cloudflared tunnel login                          # opens a browser to authorize
#   cloudflared tunnel create dogbark                 # creates the tunnel + creds file
#   cloudflared tunnel route dns dogbark bark.example.com
#
#   mkdir -p ~/.cloudflared && cat > ~/.cloudflared/config.yml <<'EOF'
#   tunnel: <TUNNEL_ID from the create step>
#   credentials-file: /home/pi/.cloudflared/<TUNNEL_ID>.json
#   ingress:
#     - hostname: bark.example.com
#       service: http://localhost:8000
#     - service: http_status:404
#   EOF
#
#   cloudflared tunnel run dogbark
#
# Then enable Cloudflare Access (Zero Trust dashboard → Access → Applications)
# on bark.example.com with an email/Google allow-list for authentication.
