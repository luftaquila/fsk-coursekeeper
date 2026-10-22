#!/bin/sh
# Build the device installers and host-file bundles a release attaches:
#   install-rover.sh + fsk-coursekeeper-rover.tar.gz   (rover/common + rover/host files)
#   install-gps.sh   + fsk-coursekeeper-gps.tar.gz     (rover/common + rover/gps/host files,
#                                                      the agent and the pilot modules it reuses)
# The installers get REPO and VERSION filled in; the agent gets VERSION as its __version__.
#
# Usage: scripts/package-devices.sh <owner/repo> <version> <out-dir>
set -eu

[ $# -eq 3 ] || { echo "usage: $(basename "$0") <owner/repo> <version> <out-dir>" >&2; exit 2; }
REPO="$1"
VERSION="$2"
OUT="$3"
ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"

render() {
    sed -e "s|@REPO@|$REPO|" -e "s|@VERSION@|$VERSION|" "$1" > "$2"
    chmod 755 "$2"
}

# Rover
mkdir -p "$STAGE/rover/files"
cp -R "$ROOT/rover/common/files/." "$ROOT/rover/host/files/." "$STAGE/rover/files/"
tar -czf "$OUT/fsk-coursekeeper-rover.tar.gz" -C "$STAGE/rover" files
render "$ROOT/rover/host/install.sh" "$OUT/install-rover.sh"

# GPS unit
GPS="$STAGE/gps/files"
AGENT="$GPS/opt/fsk-coursekeeper-gps"
mkdir -p "$AGENT/pilot/lib"
cp -R "$ROOT/rover/common/files/." "$ROOT/rover/gps/host/files/." "$GPS/"
sed -e "s|^__version__ = .*|__version__ = \"$VERSION\"|" "$ROOT/rover/gps/gps_register.py" > "$AGENT/gps_register.py"
chmod 755 "$AGENT/gps_register.py"
cp "$ROOT/rover/gps/gps_api.py" "$ROOT/rover/gps/ntrip_caster.py" "$AGENT/"
: > "$AGENT/pilot/__init__.py"
: > "$AGENT/pilot/lib/__init__.py"
for module in ubx_parser ntrip_client geo_utils rtcm_utils; do
    cp "$ROOT/rover/pilot/pilot/lib/$module.py" "$AGENT/pilot/lib/"
done
tar -czf "$OUT/fsk-coursekeeper-gps.tar.gz" -C "$STAGE/gps" files
render "$ROOT/rover/gps/host/install.sh" "$OUT/install-gps.sh"
