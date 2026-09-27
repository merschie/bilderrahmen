#!/bin/sh
# Läuft als root los, übergibt dann an PUID/PGID (Unraid-Standard: 99/100 = nobody/users)
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG_DIR"
  chown -R "$PUID:$PGID" "$CONFIG_DIR" 2>/dev/null || true
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
