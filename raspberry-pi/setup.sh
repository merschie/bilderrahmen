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

# sudo nur, wenn es ohne Passwort geht oder ein Terminal für die Passworteingabe da ist
as_root() {
  if sudo -n true 2>/dev/null; then
    sudo "$@"
  elif { true </dev/tty; } 2>/dev/null; then
    sudo "$@" </dev/tty
  else
    warn "Übersprungen (sudo braucht ein Passwort, aber es gibt kein Terminal): $*"
    return 1
  fi
}

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
  as_root apt-get update -q || true
  as_root apt-get install -y chromium || as_root apt-get install -y chromium-browser || true
  BROWSER="$(find_browser)"
  [ -n "$BROWSER" ] || die "Chromium konnte nicht installiert werden."
fi
info "Browser: $BROWSER"

# Raspberry Pi 3 und älter (Grafikchip VideoCore IV, nur OpenGL ES 2.0): Chromium stürzt im Vollbild
# mit Grafikfehlern ab und zeigt nur Schwarz. Bildinhalte dann per CPU zeichnen lassen.
EXTRA_FLAGS=""
render_driver="$(basename "$(readlink -f /sys/class/drm/renderD128/device/driver 2>/dev/null)" 2>/dev/null || true)"
if [ -n "$render_driver" ] && [ "$render_driver" != "v3d" ]; then
  EXTRA_FLAGS="--disable-gpu-rasterization"
  info "Älterer Grafikchip ($render_driver) erkannt – angepasste Darstellung für Chromium."
fi

# ---------- Automatische Anmeldung & kein Bildschirmschoner ----------
if command -v raspi-config >/dev/null; then
  info "Aktiviere automatische Anmeldung am Desktop …"
  as_root raspi-config nonint do_boot_behaviour B4 || true
  if [ "$(raspi-config nonint get_blanking 2>/dev/null)" = "1" ]; then
    info "Bildschirmschoner ist bereits aus."
  else
    info "Schalte Bildschirmschoner ab …"
    as_root raspi-config nonint do_blanking 1 || true
  fi
else
  warn "raspi-config nicht gefunden – automatische Anmeldung und Bildschirmschoner bitte selbst einstellen."
fi

# ---------- Startskript ----------
mkdir -p "$(dirname "$KIOSK")" "$(dirname "$CONF")"
printf "URL='%s'\nBROWSER='%s'\nEXTRA_FLAGS='%s'\n" "$URL" "$BROWSER" "$EXTRA_FLAGS" > "$CONF"

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
    --autoplay-policy=no-user-gesture-required --lang=de \
    $EXTRA_FLAGS "$URL"
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

# Ton über HDMI (Monitor/Fernseher) statt über die Kopfhörerbuchse – beim Pi 3 ist sonst die Buchse eingestellt
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if command -v wpctl >/dev/null; then
  hdmi="$(wpctl status 2>/dev/null | sed -n '/Sinks:/,/Sources:/p' | grep -i '(HDMI)' | grep -o '[0-9]\+\.' | head -1 | tr -d .)"
  if [ -n "$hdmi" ] && wpctl set-default "$hdmi" 2>/dev/null; then
    wpctl set-volume "$hdmi" 1.0 2>/dev/null || true
    info "Ton läuft über HDMI (Lautstärke am Monitor regeln)."
  else
    warn "Kein HDMI-Tonausgang gefunden – ggf. im Lautsprecher-Menü oben rechts auswählen."
  fi
fi

if [ "${XDG_SESSION_DESKTOP:-}" = "wayfire" ] || pgrep -x wayfire >/dev/null; then
  warn "Wayfire erkannt: Bitte in 'sudo raspi-config' → Advanced Options → Wayland auf 'labwc' umstellen."
fi

info "Fertig! Der Bilderrahmen startet ab jetzt automatisch."
echo "    Adresse ändern:  nano $CONF"
echo "    Kiosk beenden:   pkill -f bilderrahmen-kiosk; pkill chromium"
echo "    Entfernen:       dieses Skript mit --uninstall aufrufen"

case "$(ask "Jetzt neu starten? [J/n] " n)" in
  n|N|nein|Nein) echo "Der Rahmen startet beim nächsten Neustart." ;;
  *) as_root reboot || true ;;
esac
