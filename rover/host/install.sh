#!/bin/bash
# FSK Coursekeeper rover on a Raspberry Pi 5 with Raspberry Pi OS Lite (64-bit), from a release
# (the release workflow fills in REPO and VERSION):
#   curl -fsSL https://github.com/luftaquila/fsk-coursekeeper/releases/latest/download/install-rover.sh | sudo bash
# Run again (or fsk-coursekeeper-update) to change the release. Installs podman and Tailscale,
# this release's host files (files/) and pilot and hub images, sets the Pi's fan and USB power
# options, joins the tailnet (a login link the first time) under the Pi's host name and publishes
# the hub with tailscale serve. Settings already on the Pi (pilot.conf, hub.conf) are kept.
set -euo pipefail

REPO="@REPO@"
VERSION="@VERSION@"
HUB_API=http://127.0.0.1:10101
ORIGINS="https://luftaquila.github.io,https://fsk.luftaquila.io,https://test.luftaquila.io"
FIRMWARE_CONFIG=/boot/firmware/config.txt
tmp=""

# Firmware options between the markers belong to this installer and are rewritten on every run.
firmware_block() {
    cat <<'EOF'
# >>> fsk-coursekeeper
[all]
# Pin the Pi 5 cooling fan to 100% regardless of temperature.
dtparam=fan_temp0=0
dtparam=fan_temp0_speed=255
dtparam=fan_temp1=0
dtparam=fan_temp1_speed=255
dtparam=fan_temp2=0
dtparam=fan_temp2_speed=255
dtparam=fan_temp3=0
dtparam=fan_temp3_speed=255
# Allow the full 1.6A USB-A budget. The custom 8-32V->5V 30W (6A) DC-DC cannot
# USB-C PD-negotiate 5A, so the firmware caps USB-A at 600mA; a USB device
# reconnect inrush can then trip a global over-current that drops the GPS and MCU.
usb_max_current_enable=1
# <<< fsk-coursekeeper
EOF
}

# Rewrites the installer's block in config.txt; succeeds only when the file changed.
update_firmware_config() {
    local current next
    current="$(cat "$FIRMWARE_CONFIG")"
    next="$(awk '/^# >>> fsk-coursekeeper$/ { skip = 1 } !skip { print } /^# <<< fsk-coursekeeper$/ { skip = 0 }' "$FIRMWARE_CONFIG")"
    next="$next"$'\n\n'"$(firmware_block)"
    [ "$current" != "$next" ] || return 1
    printf '%s\n' "$next" > "$FIRMWARE_CONFIG"
}

# Port 443 of this Pi's tailnet name: ours, free, or another service's (left alone).
publish_hub() {
    local serve
    serve="$(tailscale serve status --json 2>/dev/null || true)"
    case "$(printf '%s' "$serve" | python3 -c '
import json, sys
text = sys.stdin.read().strip()
config = json.loads(text) if text else {}
api = sys.argv[1]
web = [h for hp, w in (config.get("Web") or {}).items() if hp.endswith(":443")
       for h in (w.get("Handlers") or {}).values()]
tcp = (config.get("TCP") or {}).get("443")
if not web and not tcp:
    print("free")
elif web and all(h.get("Proxy") == api for h in web):
    print("ours")
else:
    print("taken")
' "$HUB_API")" in
        free)
            tailscale serve --bg --https=443 "$HUB_API" || {
                echo "Enable MagicDNS and HTTPS certificates in your tailnet, then run this again." >&2
                exit 1
            } ;;
        ours) ;;
        *)
            echo "Port 443 of this Pi's tailnet name serves something else; the hub was not published." >&2
            exit 1 ;;
    esac
}

main() {
    case "$REPO$VERSION" in *@*) echo "Use install-rover.sh from a release." >&2; exit 1 ;; esac
    [ "$(id -u)" = 0 ] || { echo "Run as root: ... | sudo bash" >&2; exit 1; }
    local owner="${REPO%%/*}"
    local registry="ghcr.io/${owner,,}"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export DEBIAN_FRONTEND=noninteractive

    echo "== Packages"
    apt-get update
    apt-get install -y podman iw
    if ! command -v tailscale >/dev/null; then
        curl -fsSL https://tailscale.com/install.sh | sh
    fi

    echo "== Rover host files ($VERSION)"
    curl -fsSL "https://github.com/$REPO/releases/download/$VERSION/fsk-coursekeeper-rover.tar.gz" \
        | tar -xz --no-same-owner -C "$tmp"
    cp -r "$tmp/files/." /
    systemd-tmpfiles --create /etc/tmpfiles.d/fsk-coursekeeper.conf
    printf '%s\n' "$REPO" > /etc/fsk-coursekeeper/repo
    printf '%s\n' "$VERSION" > /etc/fsk-coursekeeper/version
    printf '%s\n' rover > /etc/fsk-coursekeeper/role
    printf '%s\n' "$registry/fsk-coursekeeper-rover-pilot:$VERSION" > /etc/fsk-coursekeeper/pilot-image
    printf '%s\n' "$registry/fsk-coursekeeper-rover-hub:$VERSION" > /etc/fsk-coursekeeper/hub-image
    install -d -m 755 /etc/pilot /etc/fsk-coursekeeper-hub
    if [ ! -f /etc/pilot/pilot.conf ]; then
        cat > /etc/pilot/pilot.conf <<'CONF'
# The pilot container's runtime config (pilot-run --env-file). bridge_node talks
# to the rover hub on this Pi (its localhost device port).
SERVER_URL=http://127.0.0.1:10100
ROS_DOMAIN_ID=0
CONF
    fi
    if [ ! -f /etc/fsk-coursekeeper-hub/hub.conf ]; then
        cat > /etc/fsk-coursekeeper-hub/hub.conf <<CONF
# The rover hub's runtime config (hub-run --env-file). After editing:
#   sudo systemctl restart fsk-coursekeeper-hub
# Web console origins allowed to call the hub from a browser (comma-separated).
HUB_ALLOWED_ORIGINS=$ORIGINS
# The name the console shows for this rover.
HUB_DEVICE_NAME=Rover
CONF
    fi
    udevadm control --reload
    udevadm trigger --subsystem-match=tty --subsystem-match=usb
    nmcli general reload

    echo "== Firmware options"
    local reboot=""
    if update_firmware_config; then
        reboot=1
    fi

    echo "== Rover images"
    podman pull "$(cat /etc/fsk-coursekeeper/pilot-image)"
    podman pull "$(cat /etc/fsk-coursekeeper/hub-image)"
    systemctl daemon-reload
    systemctl enable fsk-coursekeeper-hub.service pilot.service
    systemctl restart fsk-coursekeeper-hub.service pilot.service

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
    publish_hub

    local ready=""
    for _ in $(seq 1 30); do
        if curl -fsS "$HUB_API/api/health" >/dev/null 2>&1; then
            ready=1
            break
        fi
        sleep 1
    done
    if [ -z "$ready" ]; then
        echo "The hub did not answer on $HUB_API. Recent log:" >&2
        journalctl -u fsk-coursekeeper-hub.service -n 30 --no-pager >&2
        exit 1
    fi

    local dns
    dns="$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
    echo
    echo "FSK Coursekeeper rover $VERSION is running."
    echo "Console: Settings > Devices > add a rover at https://$dns"
    if [ -n "$reboot" ]; then
        echo "Reboot once to apply the fan and USB power options: sudo reboot"
    fi
}

# Everything runs from main so that a command reading stdin cannot swallow the rest of a piped script.
main "$@"
