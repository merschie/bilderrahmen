# Digitaler Bilderrahmen

Zeigt Fotos aus einem Ordner (inkl. aller Unterordner) als Vollbild-Diashow im Browser –
z. B. auf alten Tablets, einem Raspberry Pi am Monitor oder einem Smart-TV.

- **Eine Diashow für alle:** Der Server steuert die Diashow. Alle geöffneten Rahmen zeigen
  gleichzeitig dasselbe Bild und wechseln synchron.
- **Einstellungsseite** unter `/settings`: Ordner auswählen, Reihenfolge (zufällig,
  Aufnahmedatum auf-/absteigend, Name), Anzeigedauer, Übergangs-Animation, Darstellung.
- **Animierte Übergänge:** Überblenden, Schieben, Zoom, Unschärfe, Aufsteigen, Drehen oder
  zufällig wechselnd, dazu optional eine langsame Kamerafahrt (Ken-Burns-Effekt).
- Aufnahmedatum wird aus den EXIF-Daten gelesen (sonst Dateidatum).
- Große Fotos werden serverseitig verkleinert und richtig gedreht → flüssig auch auf schwachen Geräten.

## Installation auf Unraid

Das Image liegt auf Docker Hub: [`merschie/bilderrahmen`](https://hub.docker.com/r/merschie/bilderrahmen)
(amd64 und arm64).

Template im Unraid-Terminal herunterladen:

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-bilderrahmen.xml \
  https://raw.githubusercontent.com/merschie/bilderrahmen/main/unraid-template.xml
```

Danach in Unraid: **Docker → Add Container → Template: bilderrahmen**, Fotoordner eintragen, fertig.
Updates gehen ganz normal über „Check for Updates“ im Docker-Tab.

| Feld                        | Container          | Beispiel                          |
|-----------------------------|--------------------|-----------------------------------|
| Fotoordner                  | `/photos` (nur lesen) | `/mnt/user/Photos/`            |
| Konfiguration               | `/config`          | `/mnt/user/appdata/bilderrahmen`  |
| Web-Port                    | `8080`             | `8080`                            |
| Passwort für Einstellungen  | `ADMIN_PASSWORD`   | leer = kein Passwort              |
| Neu einlesen (Minuten)      | `RESCAN_MINUTES`   | `30`                              |
| Maximale Bildgröße (Pixel)  | `MAX_IMAGE_SIZE`   | `2560` (0 = Original)             |
| PUID / PGID                 | `PUID` / `PGID`    | `99` / `100`                      |

### Benutzen

- **Rahmen:** `http://<unraid-ip>:8080/` auf jedem Anzeigegerät öffnen
- **Einstellungen:** `http://<unraid-ip>:8080/settings`

## Raspberry Pi als Rahmen

Ein Raspberry Pi mit **Raspberry Pi OS (mit Desktop)** wird mit einem Befehl zum Bilderrahmen:
Er meldet sich automatisch an, schaltet den Bildschirmschoner ab und öffnet den Rahmen beim
Start im Vollbild.

```bash
curl -fsSL https://raw.githubusercontent.com/merschie/bilderrahmen/main/raspberry-pi/setup.sh | bash -s -- http://<unraid-ip>:8080/
```

- Der Pi wartet beim Hochfahren, bis der Server erreichbar ist.
- Stürzt Chromium ab, startet er nach wenigen Sekunden neu.
- Adresse ändern: `nano ~/.config/bilderrahmen.conf`
- Kiosk beenden: `pkill -f bilderrahmen-kiosk; pkill chromium`
- Wieder entfernen: denselben Befehl mit `--uninstall` statt der Adresse aufrufen.

Pi 3B+, 4 und 5 laufen flüssig. Auf einem Pi Zero 2 W besser die Übergänge „Überblenden“
oder „Schieben“ wählen.

## Bedienung am Rahmen

- **Maus bewegen / einmal tippen:** Bedienleiste (zurück, Pause, weiter, Vollbild, Einstellungen)
- **Wischen** oder **← / →**: vorheriges / nächstes Bild – gilt für alle Rahmen
- **Leertaste:** Pause · **F** oder **Doppelklick:** Vollbild
- Der Bildschirm wird wach gehalten, sofern der Browser die Wake-Lock-API unterstützt
  (dafür braucht es meist HTTPS oder `localhost`; sonst in den Geräte-Einstellungen den
  Bildschirm-Timeout abschalten).

## Hinweise

- Unterstützte Formate: JPG, PNG, WebP, AVIF, GIF, TIFF. HEIC (iPhone) wird nicht angezeigt.
- Ordner, die mit `.`, `@` oder `#` beginnen (z. B. `@eaDir`, `#recycle`), werden ignoriert.
- Neue Fotos werden beim nächsten Einlesen erkannt (Intervall oder Knopf „Neu einlesen“)
  und bei Zufallswiedergabe als Nächstes gezeigt.
- Einstellungen und Foto-Index liegen in `/config` und bleiben bei Updates erhalten.

## Ohne Unraid

```bash
docker run -d --name bilderrahmen -p 8080:8080 \
  -v /pfad/zu/fotos:/photos:ro -v ./config:/config \
  merschie/bilderrahmen:latest
```

Oder aus dem Quellcode: `docker compose up -d --build` (Fotos in `./photos`)
oder ganz ohne Docker: `npm install && PHOTO_DIR=./photos CONFIG_DIR=./config npm start`.

## Neue Version veröffentlichen

Jeder Push auf `main` baut das Image per GitHub Actions und lädt es als `latest` zu Docker Hub hoch.
Ein Tag wie `v1.2.0` erzeugt zusätzlich die Versions-Tags `1.2.0` und `1.2`.
