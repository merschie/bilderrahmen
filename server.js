// EXIF-Zeiten haben keine Zeitzone – intern als UTC behandeln, damit das Aufnahmedatum exakt so angezeigt wird
process.env.TZ = "UTC";

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Library } = require("./lib/library");
const { Settings } = require("./lib/settings");
const { Slideshow } = require("./lib/slideshow");
const { Tv } = require("./lib/tv");
const images = require("./lib/images");

const PORT = parseInt(process.env.PORT || "8080", 10);
const PHOTO_DIR = process.env.PHOTO_DIR || "/photos";
const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const RESCAN_MINUTES = parseFloat(process.env.RESCAN_MINUTES || "30");

fs.mkdirSync(CONFIG_DIR, { recursive: true });

const settings = new Settings(path.join(CONFIG_DIR, "settings.json"));
const library = new Library(PHOTO_DIR, path.join(CONFIG_DIR, "photo-cache.json"));
const slideshow = new Slideshow(library, settings, (photo) => {
  if (images.enabled(photo)) images.render(photo, library.abs(photo)).catch(() => {});
});

const tv = new Tv(settings);

// ---------- Live-Verbindungen (Server-Sent Events) ----------
const clients = new Set();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

function status() {
  return {
    scanning: library.scanning,
    found: library.found,
    total: library.photos.length,
    selected: slideshow.list.length,
    lastScan: library.lastScan,
    error: library.error,
    frames: [...clients].filter((c) => c.isFrame).length,
  };
}

let statusTimer = null;
function broadcastStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    broadcast("status", status());
  }, 300);
}

slideshow.on("show", (msg) => broadcast("show", msg));
slideshow.on("pause", (msg) => broadcast("pause", msg));
slideshow.on("status", broadcastStatus);
library.on("progress", broadcastStatus);
library.on("updated", () => slideshow.rebuild());
tv.on("state", (info) => broadcast("tv", info));

// ---------- Passwortschutz für die Einstellungen ----------
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const password = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
    const a = crypto.createHash("sha256").update(password).digest();
    const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Bilderrahmen"');
  res.status(401).send("Anmeldung erforderlich");
}

// ---------- Routen ----------
const app = express();
app.use(express.json());

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.isFrame = req.query.role === "frame";
  res.write("retry: 3000\n\n");
  clients.add(res);
  send(res, "settings", settings.value);
  send(res, "show", slideshow.message());
  send(res, "tv", tv.info());
  tv.setViewers(clients.size);
  broadcastStatus();
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    tv.setViewers(clients.size);
    broadcastStatus();
  });
});

app.get("/api/settings", (req, res) => res.json(settings.value));
app.get("/api/status", (req, res) => res.json(status()));
app.get("/api/folders", (req, res) => res.json(library.folderTree()));

app.put("/api/settings", requireAdmin, (req, res) => {
  const value = settings.update(req.body || {});
  broadcast("settings", value);
  slideshow.rebuild();
  slideshow.schedule(); // neue Anzeigedauer sofort übernehmen
  tv.update();
  broadcastStatus();
  res.json(value);
});

app.get("/api/tv/channels", requireAdmin, async (req, res) => {
  const channels = await tv.loadChannels(req.query.refresh === "1");
  res.json({
    host: settings.value.tvHost,
    error: tv.channelsError,
    channels: channels.map(({ key, name, group }) => ({ key, name, group })),
  });
});

app.post("/api/rescan", requireAdmin, (req, res) => {
  library.scan();
  res.json({ ok: true });
});

// Steuerung ist ohne Passwort erlaubt, damit man am Rahmen selbst wischen kann
app.post("/api/control", async (req, res) => {
  const action = req.body?.action;
  // Im Fernsehmodus schalten Vor/Zurück die Sender um
  if (settings.value.mode === "tv" && (action === "next" || action === "prev")) {
    const key = await tv.neighbour(action === "next" ? 1 : -1);
    if (key) {
      broadcast("settings", settings.update({ tvChannel: key }));
      tv.update();
    }
    return res.json({ ok: true, channel: key });
  }
  if (action === "next") slideshow.advance(1);
  else if (action === "prev") slideshow.advance(-1);
  else if (action === "pause") slideshow.setPaused(true);
  else if (action === "play") slideshow.setPaused(false);
  else if (action === "toggle") slideshow.setPaused(!slideshow.paused);
  else return res.status(400).json({ error: "Unbekannte Aktion" });
  res.json({ ok: true, paused: slideshow.paused });
});

app.get("/img/:id", async (req, res) => {
  const photo = library.byId.get(req.params.id);
  if (!photo) return res.status(404).end();
  const abs = library.abs(photo);
  res.set("Cache-Control", "public, max-age=604800, immutable");
  if (images.enabled(photo)) {
    try {
      return res.type("jpeg").send(await images.render(photo, abs));
    } catch (e) {
      console.warn(`Bild konnte nicht verkleinert werden (${photo.rel}): ${e.message}`);
    }
  }
  res.sendFile(abs, (err) => err && !res.headersSent && res.status(404).end());
});

app.use("/tv", express.static(Tv.root, {
  setHeaders: (res, file) => res.set("Cache-Control", file.endsWith(".m3u8") ? "no-cache" : "max-age=60"),
}));
app.get("/vendor/hls.min.js", (req, res) => res.sendFile(require.resolve("hls.js/dist/hls.min.js")));
app.get("/settings", requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "views", "settings.html")));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Start ----------
(async () => {
  await library.loadCache();
  app.listen(PORT, () => {
    console.log(`Bilderrahmen läuft auf Port ${PORT}`);
    console.log(`Fotos: ${PHOTO_DIR} · Konfiguration: ${CONFIG_DIR}`);
  });
  await library.scan();
  if (RESCAN_MINUTES > 0) setInterval(() => library.scan(), RESCAN_MINUTES * 60 * 1000);
})();
