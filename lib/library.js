const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const exifr = require("exifr");

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".tif", ".tiff"]);

// Systemordner von Unraid, Synology, macOS usw. ignorieren
function skipDir(name) {
  return name.startsWith(".") || name.startsWith("@") || name.startsWith("#") || name === "lost+found";
}

// EXIF-Daten stehen am Dateianfang – nur diesen Teil lesen (schont Netzwerk-Shares)
const HEAD_BYTES = 512 * 1024;
async function readHead(file) {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

class Library extends EventEmitter {
  constructor(root, cacheFile) {
    super();
    this.root = root;
    this.cacheFile = cacheFile;
    this.photos = [];
    this.byId = new Map();
    this.scanning = false;
    this.found = 0;
    this.lastScan = null;
    this.error = null;
    this.cache = {};
  }

  async loadCache() {
    try {
      this.cache = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
    } catch {
      this.cache = {};
    }
  }

  async saveCache() {
    const tmp = this.cacheFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.cache));
    await fs.rename(tmp, this.cacheFile);
  }

  abs(photo) {
    return path.join(this.root, photo.rel);
  }

  async walk(rel, out) {
    let entries;
    try {
      entries = await fs.readdir(path.join(this.root, rel), { withFileTypes: true });
    } catch (e) {
      console.warn(`Ordner nicht lesbar: ${rel || "/"} (${e.code})`);
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(this.root, childRel));
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch { continue; }
      }
      if (isDir && !skipDir(entry.name)) {
        await this.walk(childRel, out);
      } else if (isFile && !entry.name.startsWith(".") && IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push({ rel: childRel, dir: rel, name: entry.name });
        this.found++;
        if (this.found % 250 === 0) this.emit("progress");
      }
    }
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this.found = 0;
    this.error = null;
    this.emit("progress");
    const started = Date.now();

    try {
      await fs.access(this.root);
      const files = [];
      await this.walk("", files);

      const nextCache = {};
      const photos = [];
      await pool(files, 8, async (f) => {
        let st;
        try { st = await fs.stat(path.join(this.root, f.rel)); } catch { return; }
        const mtime = Math.round(st.mtimeMs);
        let entry = this.cache[f.rel];
        if (!entry || entry.mtime !== mtime || entry.size !== st.size) {
          let taken = null;
          try {
            const head = await readHead(path.join(this.root, f.rel));
            const exif = await exifr.parse(head, ["DateTimeOriginal", "CreateDate"]);
            const d = exif?.DateTimeOriginal || exif?.CreateDate;
            if (d instanceof Date && !isNaN(d)) taken = d.getTime();
          } catch { /* keine EXIF-Daten */ }
          entry = { mtime, size: st.size, taken };
        }
        nextCache[f.rel] = entry;
        photos.push({
          id: crypto.createHash("sha1").update(f.rel).digest("hex").slice(0, 16),
          rel: f.rel,
          dir: f.dir,
          name: f.name,
          mtime,
          taken: entry.taken ?? mtime,
          exifDate: entry.taken != null,
        });
      });

      photos.sort((a, b) => a.rel.localeCompare(b.rel, "de", { numeric: true }));
      this.photos = photos;
      this.byId = new Map(photos.map((p) => [p.id, p]));
      this.cache = nextCache;
      this.lastScan = Date.now();
      await this.saveCache().catch((e) => console.warn("Cache konnte nicht gespeichert werden:", e.message));
      console.log(`Scan fertig: ${photos.length} Fotos in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      this.error = `Fotoordner nicht erreichbar: ${this.root}`;
      console.error(this.error, e.message);
    } finally {
      this.scanning = false;
      this.emit("progress");
      this.emit("updated");
    }
  }

  // Baum aller Ordner mit Fotoanzahl (inkl. Unterordner)
  folderTree() {
    const root = { name: "Alle Fotos", path: "", count: 0, children: new Map() };
    for (const p of this.photos) {
      root.count++;
      let node = root;
      if (!p.dir) continue;
      let acc = "";
      for (const part of p.dir.split("/")) {
        acc = acc ? `${acc}/${part}` : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path: acc, count: 0, children: new Map() });
        node = node.children.get(part);
        node.count++;
      }
    }
    const toJson = (n) => ({
      name: n.name,
      path: n.path,
      count: n.count,
      children: [...n.children.values()]
        .sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true }))
        .map(toJson),
    });
    return toJson(root);
  }
}

module.exports = { Library };
