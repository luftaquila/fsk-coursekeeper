#!/bin/bash
# FSK Coursekeeper GPS unit on a Raspberry Pi Zero 2 W with Raspberry Pi OS Lite (64-bit), from a
# release (the release workflow fills in REPO and VERSION):
#   curl -fsSL https://github.com/luftaquila/fsk-coursekeeper/releases/latest/download/install-gps.sh | sudo bash
# Run again (or fsk-coursekeeper-update) to change the release. Installs Tailscale and this
# release's agent and host files (files/), joins the tailnet (a login link the first time) under
# the Pi's host name and publishes the API and the NTRIP caster with tailscale serve. gps.conf
# already on the Pi is kept.
set -euo pipefail

REPO="@REPO@"
VERSION="@VERSION@"
API_PORT=10200
CASTER_PORT=2101
ORIGINS="https://luftaquila.github.io,https://fsk.luftaquila.io,https://test.luftaquila.io"
UNIT=fsk-coursekeeper-gps.service
tmp=""

main() {
    case "$REPO$VERSION" in *@*) echo "Use install-gps.sh from a release." >&2; exit 1 ;; esac
    [ "$(id -u)" = 0 ] || { echo "Run as root: ... | sudo bash" >&2; exit 1; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export DEBIAN_FRONTEND=noninteractive

    echo "== Packages"
    apt-get update
    apt-get install -y python3-serial
    if ! command -v tailscale >/dev/null; then
        curl -fsSL https://tailscale.com/install.sh | sh
    fi

    echo "== GPS unit files ($VERSION)"
    curl -fsSL "https://github.com/$REPO/releases/download/$VERSION/fsk-coursekeeper-gps.tar.gz" \
        | tar -xz --no-same-owner -C "$tmp"
    # The agent directory is replaced whole so no file of an older release stays behind.
    rm -rf /opt/fsk-coursekeeper-gps
    cp -r "$tmp/files/." /
    install -d -m 755 /etc/fsk-coursekeeper /etc/fsk-coursekeeper-gps
    printf '%s\n' "$REPO" > /etc/fsk-coursekeeper/repo
    printf '%s\n' "$VERSION" > /etc/fsk-coursekeeper/version
    printf '%s\n' gps > /etc/fsk-coursekeeper/role
    if [ ! -f /etc/fsk-coursekeeper-gps/gps.conf ]; then
        cat > /etc/fsk-coursekeeper-gps/gps.conf <<CONF
# The GPS unit's runtime config (systemd EnvironmentFile). After editing:
#   sudo systemctl restart $UNIT
# The NGII login is set in the console and kept in the unit's state, not here.
API_PORT=$API_PORT
CASTER_PORT=$CASTER_PORT
CASTER_MOUNTPOINT=FSKBASE
# Web console origins allowed to call the API from a browser (comma-separated).
ALLOWED_ORIGINS=$ORIGINS
CONF
    fi
    udevadm control --reload
    udevadm trigger --subsystem-match=tty --subsystem-match=usb

    echo "== GPS unit service"
    systemctl daemon-reload
    systemctl enable "$UNIT"
    systemctl restart "$UNIT"

    echo "== Tailscale"
    local state
    state="$(tailscale status --json 2>/dev/null \
        | python3 -c 'import json, sys; print(json.load(sys.stdin).get("BackendState", ""))' || true)"
    # The Pi's own DNS stays off Tailscale: after a long power-off its clock is behind, Tailscale's
    # TLS fails, and time sync must still resolve its servers.
    if [ "$state" != Running ]; then
        echo "Open the link below and log in to your tailnet."
        tailscale up --accept-dns=false
    else
        tailscale set --accept-dns=false
    fi
    # Single-purpose device: rebuild the whole serve config so a changed port never leaves a
    # stale handler behind.
    tailscale serve reset
    if ! timeout 60 tailscale serve --bg --https=443 "http://127.0.0.1:$API_PORT" ||
       ! timeout 60 tailscale serve --bg --tcp="$CASTER_PORT" "tcp://127.0.0.1:$CASTER_PORT"; then
        echo "Enable MagicDNS and HTTPS certificates in your tailnet, then run this again." >&2
        exit 1
    fi

    local ready=""
    for _ in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 1
    done
    if [ -z "$ready" ]; then
        echo "The GPS unit API did not answer. Recent log:" >&2
        journalctl -u "$UNIT" -n 30 --no-pager >&2
        exit 1
    fi

    local dns
    dns="$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
    echo
    echo "FSK Coursekeeper GPS unit $VERSION is running."
    echo "Console: Settings > Devices > add a GPS unit at https://$dns, then set its NGII login in its panel"
}

# Everything runs from main so that a command reading stdin cannot swallow the rest of a piped script.
main "$@"
