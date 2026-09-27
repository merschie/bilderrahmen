// Verkleinert Fotos für die Anzeige (schneller auf Tablets & Co.) und dreht sie laut EXIF richtig.
let sharp = null;
try {
  sharp = require("sharp");
  sharp.cache(false);
  sharp.concurrency(2);
} catch {
  console.warn("sharp nicht verfügbar – Originalbilder werden ausgeliefert");
}

const MAX_SIZE = parseInt(process.env.MAX_IMAGE_SIZE || "2560", 10);
const CACHE_ENTRIES = 8;
const cache = new Map(); // key -> Promise<Buffer>

function enabled(photo) {
  return sharp && MAX_SIZE > 0 && !photo.name.toLowerCase().endsWith(".gif");
}

function render(photo, absPath) {
  const key = `${photo.id}:${photo.mtime}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const job = sharp(absPath, { failOn: "none" })
    .rotate()
    .resize(MAX_SIZE, MAX_SIZE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return job;
}

module.exports = { enabled, render };
