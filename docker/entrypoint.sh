#!/bin/sh
# Talaia's container starts here, as root, to leave things ready and then run Talaia as «talaia» (uid 4404):
#  - the data folder (/data) becomes the service user's (a new bind mount, a backup copied in as root…);
#  - with the compose's Mosquitto (TALAIA_BROKER set and its volume mounted on /broker): Mosquitto's configuration and,
#    the first time, its users file, made by Talaia (`talaia --broker-inicial`), as the installer does;
#  - Talaia also gets the groups of the serial ports passed to the container, so the USB node opens whatever the
#    machine calls that group.
# Started as another user (docker run --user, rootless), none of that: it just runs.
set -eu

# «docker run … talaia-hub --version»: options for Talaia.
case "${1:-}" in -*) set -- talaia "$@" ;; esac

if [ "$(id -u)" != 0 ]; then exec "$@"; fi

DATA="${TALAIA_DATA:-/data}"
mkdir -p "$DATA"
find "$DATA" -xdev \( ! -user talaia -o ! -group talaia \) -exec chown talaia:talaia {} + 2>/dev/null || true
chmod 750 "$DATA" # it holds the password Talaia uses on its broker

BROKER=/broker
if [ -n "${TALAIA_BROKER:-}" ] && [ "$TALAIA_BROKER" != off ] && mountpoint -q "$BROKER"; then
  case "$TALAIA_BROKER" in
    *:[0-9]*) PUERTO="${TALAIA_BROKER##*:}" ;;
    *) PUERTO=1883 ;;
  esac
  # Paths as Mosquitto's container sees them (eclipse-mosquitto: this volume on /mosquitto/data, its user uid 1883).
  cat > "$BROKER/mosquitto.conf" <<EOF
# Written by Talaia each time it starts (docker/entrypoint.sh): changes made here are lost.
listener $PUERTO
allow_anonymous false
plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /mosquitto/data/talaia-dynamic-security.json
persistence true
persistence_location /mosquitto/data/
log_dest stdout
EOF
  # The users: Mosquitto's from then on (it keeps them there); only made if they aren't.
  if [ ! -s "$BROKER/talaia-dynamic-security.json" ]; then
    talaia --broker-inicial > "$BROKER/.inicial.json"
    mv "$BROKER/.inicial.json" "$BROKER/talaia-dynamic-security.json"
    echo "talaia-entrypoint: first users file for Mosquitto in $BROKER"
  fi
  chown -R 1883:1883 "$BROKER"
  chmod 600 "$BROKER/talaia-dynamic-security.json"
  chmod 644 "$BROKER/mosquitto.conf"
fi

# Groups: «talaia»'s own (dialout) and those of the serial ports in the container (not root's).
GRUPOS="$(id -G talaia)"
RX="${TALAIA_RECEIVER:-}"
for d in /dev/ttyACM* /dev/ttyUSB* "${RX#usb:}"; do
  case "$d" in /dev/*) [ -c "$d" ] && GRUPOS="$GRUPOS $(stat -c %g "$d")" ;; esac
done
GRUPOS="$(echo "$GRUPOS" | tr ' ' '\n' | grep -vx 0 | sort -un | paste -sd, -)"

exec setpriv --reuid=talaia --regid=talaia --groups="$GRUPOS" -- "$@"
