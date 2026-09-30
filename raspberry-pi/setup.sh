#!/usr/bin/env bash
# Richtet einen Raspberry Pi als Anzeige für den Bilderrahmen ein:
# automatische Anmeldung, kein Bildschirmschoner, Chromium startet im Vollbild mit dem Rahmen.
#
# Einrichten:  curl -fsSL https://raw.githubusercontent.com/merschie/bilderrahmen/main/raspberry-pi/setup.sh | bash -s -- http://<server>:8080/
# Entfernen:   curl -fsSL https://raw.githubusercontent.com/merschie/bilderrahmen/main/raspberry-pi/setup.sh | bash -s -- --uninstall
set -euo pipefail

KIOSK="$HOME/.local/bin/bilderrahmen-kiosk"
CONF="$HOME/.config/bilderrahmen.conf"
XDG_AUTOSTART="$HOME/.config/autostart/bilderrahmen.desktop"
LABWC_AUTOSTART="$HOME/.config/labwc/autostart"
MARK="# bilderrahmen"

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

# Eingaben kommen vom Terminal, auch wenn das Skript per "curl | bash" läuft.
# ask <Frage> [Antwort, falls kein Terminal verfügbar ist]
ask() {
  local answer=""
  if { true </dev/tty; } 2>/dev/null; then
    read -rp "$1" answer </dev/tty || answer="${2:-}"
  else
    answer="${2:-}"
  fi
  printf '%s' "$answer"
}

[ "$(id -u)" -ne 0 ] || die "Bitte als normaler Benutzer ausführen, nicht mit sudo."

uninstall() {
  pkill -f "$KIOSK" 2>/dev/null || true
  pkill -f "chromium.*--kiosk" 2>/dev/null || true
  rm -f "$KIOSK" "$CONF" "$XDG_AUTOSTART"
  if [ -f "$LABWC_AUTOSTART" ]; then sed -i "/$MARK/d" "$LABWC_AUTOSTART"; fi
  info "Bilderrahmen-Autostart entfernt."
  info "Automatische Anmeldung und Bildschirmschoner lassen sich mit 'sudo raspi-config' wieder ändern."
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

# ---------- Voraussetzungen ----------
if [ ! -d /usr/share/wayland-sessions ] && [ ! -d /usr/share/xsessions ]; then
  die "Keine Desktop-Umgebung gefunden. Bitte 'Raspberry Pi OS mit Desktop' verwenden (nicht 'Lite')."
fi

# ---------- Server-Adresse ----------
URL="${1:-}"
if [ -z "$URL" ] && [ -f "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi
if [ -z "$URL" ]; then
  URL="$(ask "Adresse des Bilderrahmen-Servers (z. B. http://192.168.178.80:8080/): ")"
fi
[ -n "$URL" ] || die "Keine Adresse angegeben."
case "$URL" in
  http://*|https://*) ;;
  *) URL="http://$URL" ;;
esac

if curl -fs -o /dev/null --max-time 5 "${URL%/}/api/status"; then
  info "Server erreichbar: $URL"
else
  warn "Server unter $URL gerade nicht erreichbar. Der Pi wartet beim Start darauf."
fi

# ---------- Browser ----------
find_browser() { command -v chromium || command -v chromium-browser || true; }
BROWSER="$(find_browser)"
if [ -z "$BROWSER" ]; then
  info "Installiere Chromium …"
  sudo apt-get update -q
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
  BROWSER="$(find_browser)"
  [ -n "$BROWSER" ] || die "Chromium konnte nicht installiert werden."
fi
info "Browser: $BROWSER"

# ---------- Automatische Anmeldung & kein Bildschirmschoner ----------
if command -v raspi-config >/dev/null; then
  info "Aktiviere automatische Anmeldung am Desktop …"
  sudo raspi-config nonint do_boot_behaviour B4
  info "Schalte Bildschirmschoner ab …"
  sudo raspi-config nonint do_blanking 1
else
  warn "raspi-config nicht gefunden – automatische Anmeldung und Bildschirmschoner bitte selbst einstellen."
fi

# ---------- Startskript ----------
mkdir -p "$(dirname "$KIOSK")" "$(dirname "$CONF")"
printf "URL='%s'\nBROWSER='%s'\n" "$URL" "$BROWSER" > "$CONF"

cat > "$KIOSK" <<'EOF'
#!/bin/sh
# Startet den Bilderrahmen im Vollbild. Adresse ändern: ~/.config/bilderrahmen.conf
. "$HOME/.config/bilderrahmen.conf"

# Nur eine Instanz, auch wenn mehrere Autostart-Mechanismen greifen
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/bilderrahmen-kiosk.lock"
flock -n 9 || exit 0

# Warten, bis Netzwerk und Server da sind
until curl -s -o /dev/null --max-time 5 "$URL"; do sleep 3; done

# Chromium nach Absturz oder Beenden automatisch neu starten
while true; do
  "$BROWSER" --kiosk --incognito --noerrdialogs --disable-infobars \
    --disable-session-crashed-bubble --disable-features=Translate \
    --password-store=basic --check-for-update-interval=31536000 \
    "$URL"
  sleep 5
done
EOF
chmod +x "$KIOSK"

# ---------- Autostart ----------
# labwc (aktuelles Raspberry Pi OS)
if command -v labwc >/dev/null; then
  mkdir -p "$(dirname "$LABWC_AUTOSTART")"
  touch "$LABWC_AUTOSTART"
  sed -i "/$MARK/d" "$LABWC_AUTOSTART"
  echo "$KIOSK & $MARK" >> "$LABWC_AUTOSTART"
fi
# X11 und andere Desktops (XDG-Autostart)
mkdir -p "$(dirname "$XDG_AUTOSTART")"
cat > "$XDG_AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=Bilderrahmen
Exec=$KIOSK
X-GNOME-Autostart-enabled=true
EOF

if [ "${XDG_SESSION_DESKTOP:-}" = "wayfire" ] || pgrep -x wayfire >/dev/null; then
  warn "Wayfire erkannt: Bitte in 'sudo raspi-config' → Advanced Options → Wayland auf 'labwc' umstellen."
fi

info "Fertig! Der Bilderrahmen startet ab jetzt automatisch."
echo "    Adresse ändern:  nano $CONF"
echo "    Kiosk beenden:   pkill -f bilderrahmen-kiosk; pkill chromium"
echo "    Entfernen:       dieses Skript mit --uninstall aufrufen"

case "$(ask "Jetzt neu starten? [J/n] " n)" in
  n|N|nein|Nein) echo "Der Rahmen startet beim nächsten Neustart." ;;
  *) sudo reboot ;;
esac
