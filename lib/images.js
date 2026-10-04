// Verkleinert Fotos für die Anzeige (schneller auf Tablets & Co.) und dreht sie laut EXIF richtig.
// Jeder Rahmen bekommt die Größe seines Bildschirms – schwache Geräte wie ein Raspberry Pi 3 haben
// nur wenig Grafikspeicher und stürzen bei zu großen Bildern ab.
let sharp = null;
try {
  sharp = require("sharp");
  sharp.cache(false);
  sharp.concurrency(2);
} catch {
  console.warn("sharp nicht verfügbar – Originalbilder werden ausgeliefert");
}

const MAX_SIZE = parseInt(process.env.MAX_IMAGE_SIZE || "2560", 10);
const SIZES = [640, 960, 1280, 1920, 2560, 3840];
const BG_SIZE = 96; // Hintergrund: winzig und unscharf, der Browser skaliert ihn nur hoch
const CACHE_ENTRIES = 16;
const cache = new Map(); // key -> Promise<Buffer>
const recentSizes = new Map(); // Größe -> zuletzt angefragt (für das Vorbereiten des nächsten Fotos)

function enabled(photo) {
  return sharp && MAX_SIZE > 0 && !photo.name.toLowerCase().endsWith(".gif");
}

// Gewünschte Breite auf feste Stufen runden, damit der Zwischenspeicher greift
function sizeFor(requested) {
  const w = parseInt(requested, 10);
  if (!w) return MAX_SIZE;
  return Math.min(MAX_SIZE, SIZES.find((s) => s >= w) || SIZES[SIZES.length - 1]);
}

function render(photo, absPath, { size = MAX_SIZE, background = false } = {}) {
  const key = `${photo.id}:${photo.mtime}:${background ? "bg" : size}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (!background) recentSizes.set(size, Date.now());
  let pipeline = sharp(absPath, { failOn: "none" }).rotate();
  pipeline = background
    ? pipeline.resize(BG_SIZE, BG_SIZE, { fit: "inside" }).blur(2.5).modulate({ brightness: 0.5, saturation: 1.2 })
      .jpeg({ quality: 70 })
    : pipeline.resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85, progressive: true });
  const job = pipeline.toBuffer();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return job;
}

// Nächstes Foto vorab in allen Größen aufbereiten, die Rahmen in der letzten Stunde angefragt haben
function prepare(photo, absPath) {
  const hourAgo = Date.now() - 3600 * 1000;
  for (const [size, at] of recentSizes) {
    if (at < hourAgo) recentSizes.delete(size);
    else render(photo, absPath, { size }).catch(() => {});
  }
  render(photo, absPath, { background: true }).catch(() => {});
}

module.exports = { enabled, render, prepare, sizeFor };
