#!/bin/sh
# Provision the FSK Coursekeeper GPS unit (Raspberry Pi Zero 2 W) from the
# admin machine. Counterpart to provision-rover.sh, but the GPS unit runs
# Raspberry Pi OS Lite (cloud-init headless), not the AlmaLinux bootc host —
# so this script also DEPLOYS the agent code.
#
# Usage:
#   scripts/provision-gps.sh <host> [--allowed-origins=<origin,...>] \
#       [--tailscale-authkey=<tskey-...>]
#
# What it does (idempotent):
#   1. tars the GPS agent + the reused pilot.lib.* modules and copies them in,
#   2. apt-installs python3-serial and Tailscale,
#   3. sets the hostname to fsk-coursekeeper-gps,
#   4. installs /opt/fsk-coursekeeper-gps, the systemd unit, and the udev rule,
#   5. writes /etc/fsk-coursekeeper-gps/gps.conf (0600 root),
#   6. enables + restarts fsk-coursekeeper-gps.service,
#   7. brings Tailscale up if an auth key was given, sets the Tailscale
#      hostname, and publishes the API (HTTPS 443) and the NTRIP caster (TCP)
#      with `tailscale serve`,
#   8. verifies the service stays active and the API answers.
#
# Re-running against the same unit is safe — files are overwritten, config is
# rewritten (the NGII login lives in the unit's state, set from the console), and
# apt/tailscale installs are no-ops when already present.

set -eu

GPS_HOSTNAME="fsk-coursekeeper-gps"
API_PORT=10200
CASTER_PORT=2101
CASTER_MOUNTPOINT="FSKBASE"
DEFAULT_ALLOWED_ORIGINS="https://luftaquila.github.io,https://fsk.luftaquila.io,https://test.luftaquila.io"

usage() {
    cat >&2 <<EOF
usage: $(basename "$0") <host> [--allowed-origins=<origin,...>]
                        [--tailscale-authkey=<key>]

  --allowed-origins    browser origins allowed by CORS
                       (default: $DEFAULT_ALLOWED_ORIGINS)
  --tailscale-authkey  bring Tailscale up with this key

Requires SSH key auth for fsk@<host> (cloud-init seeded https://github.com/luftaquila.keys).
EOF
    exit 2
}

HOST=""
TS_AUTHKEY=""
ALLOWED_ORIGINS="$DEFAULT_ALLOWED_ORIGINS"
for arg in "$@"; do
    case "$arg" in
        --tailscale-authkey=*) TS_AUTHKEY="${arg#*=}" ;;
        --allowed-origins=*)   ALLOWED_ORIGINS="${arg#*=}" ;;
        -h|--help)             usage ;;
        -*)                    echo "unknown flag: $arg" >&2; usage ;;
        *)                     [ -z "$HOST" ] && HOST="$arg" || usage ;;
    esac
done
[ -n "$HOST" ] || usage
case "$ALLOWED_ORIGINS" in
    *[[:space:]]*) echo "--allowed-origins must be a comma list without spaces" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
GPS_DIR="$REPO_ROOT/rover/gps"
PILOT_LIB="$REPO_ROOT/rover/pilot/pilot/lib"
[ -d "$GPS_DIR" ] || { echo "cannot find $GPS_DIR" >&2; exit 1; }

printf 'provisioning fsk@%s (GPS unit)\n' "$HOST"
printf '  hostname:        %s\n' "$GPS_HOSTNAME"
printf '  ALLOWED_ORIGINS: %s\n' "$ALLOWED_ORIGINS"
printf '  API / caster:    127.0.0.1:%s / 127.0.0.1:%s/%s\n' "$API_PORT" "$CASTER_PORT" "$CASTER_MOUNTPOINT"
printf '  Tailscale:       %s\n\n' "$([ -n "$TS_AUTHKEY" ] && echo 'up via auth key' || echo 'use the existing login')"

SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

# 1. Assemble a staging tree: the agent + the reused pilot.lib.* modules
#    (single source of truth — copied from pilot, not vendored in git).
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/systemd" "$STAGING/udev" "$STAGING/pilot/lib"
cp "$GPS_DIR/gps_register.py" "$GPS_DIR/gps_api.py" "$GPS_DIR/ntrip_caster.py" \
    "$GPS_DIR/requirements.txt" "$GPS_DIR/README.md" "$STAGING/"
cp "$GPS_DIR/systemd/fsk-coursekeeper-gps.service" "$STAGING/systemd/"
cp "$GPS_DIR/udev/99-fsk-coursekeeper-gps.rules" "$STAGING/udev/"
: > "$STAGING/pilot/__init__.py"
: > "$STAGING/pilot/lib/__init__.py"
for m in ubx_parser ntrip_client geo_utils rtcm_utils; do
    cp "$PILOT_LIB/$m.py" "$STAGING/pilot/lib/"
done

# 2. Ship the tarball over SSH (no rsync dependency on the Pi).
echo "[local] copying agent bundle to fsk@$HOST"
tar -cz -C "$STAGING" . | ssh $SSH_OPTS "fsk@$HOST" 'cat > /tmp/gps-deploy.tgz'

# 3. Remote provisioning. Values arrive on stdin (kept off argv); the heredoc
#    body is quoted so nothing expands locally. Every command that could read
#    stdin gets </dev/null so it cannot swallow the rest of this script.
{
    printf '%s\n' "$TS_AUTHKEY"
    printf '%s\n' "$ALLOWED_ORIGINS"
    printf '%s\n' "$GPS_HOSTNAME"
    printf '%s\n' "$API_PORT"
    printf '%s\n' "$CASTER_PORT"
    printf '%s\n' "$CASTER_MOUNTPOINT"
    cat <<'REMOTE'
set -eu
CONF_DIR=/etc/fsk-coursekeeper-gps
CONF="$CONF_DIR/gps.conf"
OPT=/opt/fsk-coursekeeper-gps
UNIT=fsk-coursekeeper-gps.service

echo "[gps] installing python deps + tailscale"
sudo apt-get update -qq </dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-serial </dev/null >/dev/null
if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh </dev/null | sh
fi

echo "[gps] setting hostname $GPS_HOSTNAME"
sudo hostnamectl set-hostname "$GPS_HOSTNAME" </dev/null
if grep -q '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
    sudo sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$GPS_HOSTNAME/" /etc/hosts
else
    printf '127.0.1.1\t%s\n' "$GPS_HOSTNAME" | sudo tee -a /etc/hosts >/dev/null
fi
if [ -d /etc/cloud/cloud.cfg.d ]; then
    # Keep cloud-init from restoring the first-boot hostname / hosts file.
    printf 'preserve_hostname: true\nmanage_etc_hosts: false\n' |
        sudo tee /etc/cloud/cloud.cfg.d/99-fsk-coursekeeper-gps.cfg >/dev/null
fi

echo "[gps] hardening cold-boot clock/tailscale ordering (RTC-less, no fake-hwclock)"
# This Pi has no RTC and no fake-hwclock, so a cold boot starts with a wrong
# clock. tailscaled control-TLS then fails ("cert not yet valid"), tailscale
# stays down, and MagicDNS (the only entry in the tailscale-managed resolv.conf)
# is down too -> all DNS fails -> timesyncd cannot resolve the debian.pool.ntp.org
# hostnames -> the clock never syncs -> deadlock that only a reboot clears.
# Fix (mirrors the rover chrony fix): pin DNS-free NTP IPs so timesyncd can
# step the clock without DNS, gate tailscaled on time-sync.target, and enable
# systemd-time-wait-sync so the target waits for an actual clock sync.
sudo install -d -m 755 /etc/systemd/timesyncd.conf.d
sudo tee /etc/systemd/timesyncd.conf.d/10-dns-free-ntp.conf >/dev/null <<'NTPCONF'
[Time]
# Cloudflare + Google anycast NTP, by IP so timesyncd can step the clock without
# DNS on a cold boot (FallbackNTP still covers the DNS pool once time is sane).
NTP=162.159.200.123 216.239.35.0
NTPCONF
sudo install -d -m 755 /etc/systemd/system/tailscaled.service.d
sudo tee /etc/systemd/system/tailscaled.service.d/override.conf >/dev/null <<'TSCONF'
[Unit]
# Start tailscaled only after the clock is synchronised, so an RTC-less cold boot
# never hands it a wrong clock (control-TLS "cert not yet valid" -> deadlock).
After=time-sync.target
Wants=time-sync.target
TSCONF
sudo systemctl enable systemd-time-wait-sync.service </dev/null >/dev/null 2>&1 || true
sudo systemctl daemon-reload </dev/null
sudo systemctl restart systemd-timesyncd </dev/null

echo "[gps] deploying agent to $OPT"
TMP="$(mktemp -d)"
tar -xzf /tmp/gps-deploy.tgz -C "$TMP"
sudo install -d -m 755 "$OPT"
sudo install -m 755 "$TMP/gps_register.py" "$OPT/gps_register.py"
sudo install -m 644 "$TMP/gps_api.py" "$TMP/ntrip_caster.py" \
    "$TMP/requirements.txt" "$TMP/README.md" "$OPT/"
sudo rm -rf "$OPT/pilot"
sudo cp -r "$TMP/pilot" "$OPT/pilot"
sudo install -m 644 "$TMP/systemd/$UNIT" "/etc/systemd/system/$UNIT"
sudo install -m 644 "$TMP/udev/99-fsk-coursekeeper-gps.rules" /etc/udev/rules.d/99-fsk-coursekeeper-gps.rules
rm -rf "$TMP" /tmp/gps-deploy.tgz

echo "[gps] writing $CONF"
sudo install -d -m 755 "$CONF_DIR"
# 0600 root-owned; systemd reads it as EnvironmentFile.
umask 077
sudo tee "$CONF" >/dev/null <<EOF
API_PORT=$API_PORT
CASTER_PORT=$CASTER_PORT
CASTER_MOUNTPOINT=$CASTER_MOUNTPOINT
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
DEVICE_ID=$GPS_HOSTNAME
EOF
sudo chmod 600 "$CONF"

echo "[gps] reloading udev"
sudo udevadm control --reload-rules </dev/null
sudo udevadm trigger --subsystem-match=tty --subsystem-match=usb </dev/null

echo "[gps] enabling + restarting $UNIT"
sudo systemctl daemon-reload </dev/null
sudo systemctl enable "$UNIT" </dev/null >/dev/null 2>&1 || true
sudo systemctl restart "$UNIT" </dev/null

if [ -n "$TS_AUTHKEY" ]; then
    echo "[gps] bringing Tailscale up"
    sudo tailscale up --auth-key="$TS_AUTHKEY" --hostname="$GPS_HOSTNAME" </dev/null
fi

TS_SERVE=skipped
if sudo tailscale status </dev/null >/dev/null 2>&1; then
    echo "[gps] publishing the API and caster with tailscale serve"
    sudo tailscale set --hostname="$GPS_HOSTNAME" </dev/null
    # Single-purpose device: rebuild the whole serve config so a changed port
    # never leaves a stale handler behind.
    sudo tailscale serve reset </dev/null
    if ! sudo timeout 60 tailscale serve --bg --https=443 "http://127.0.0.1:$API_PORT" </dev/null ||
       ! sudo timeout 60 tailscale serve --bg --tcp="$CASTER_PORT" "tcp://127.0.0.1:$CASTER_PORT" </dev/null; then
        echo "[gps] tailscale serve failed — enable MagicDNS and HTTPS certificates for the tailnet, then re-run" >&2
        exit 1
    fi
    TS_SERVE=configured
fi

# Settle, then assert health — bad config/serial crash within ~8 s.
sleep 8
if sudo systemctl is-active --quiet "$UNIT"; then
    echo "[gps] $UNIT: active"
else
    echo "[gps] $UNIT: NOT active — recent log:" >&2
    sudo journalctl -u "$UNIT" -n 30 --no-pager </dev/null >&2
    exit 1
fi
if curl -fsS "http://127.0.0.1:$API_PORT/api/health" </dev/null >/dev/null; then
    echo "[gps] API: healthy"
else
    echo "[gps] API: no answer on 127.0.0.1:$API_PORT" >&2
    exit 1
fi
if [ "$TS_SERVE" = skipped ]; then
    echo "[gps] Tailscale is not up — tailscale serve skipped. Run 'sudo tailscale up' on the unit, then re-run this script." >&2
fi
REMOTE
} | ssh $SSH_OPTS "fsk@$HOST" \
    'IFS= read -r TS_AUTHKEY
     IFS= read -r ALLOWED_ORIGINS
     IFS= read -r GPS_HOSTNAME
     IFS= read -r API_PORT
     IFS= read -r CASTER_PORT
     IFS= read -r CASTER_MOUNTPOINT
     export TS_AUTHKEY ALLOWED_ORIGINS GPS_HOSTNAME API_PORT CASTER_PORT CASTER_MOUNTPOINT
     sh -s'

printf '\nprovisioning complete. Tail logs with:\n'
printf '  ssh fsk@%s sudo journalctl -u fsk-coursekeeper-gps.service -f\n' "$HOST"
printf 'The unit now answers as %s (mDNS: %s.local).\n' "$GPS_HOSTNAME" "$GPS_HOSTNAME"
