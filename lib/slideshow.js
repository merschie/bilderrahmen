// Eine zentrale Diashow für den ganzen Container: alle Rahmen zeigen dasselbe Bild.
const { EventEmitter } = require("events");
const { TRANSITIONS } = require("./settings");

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Slideshow extends EventEmitter {
  constructor(library, settings, prepare) {
    super();
    this.library = library;
    this.settings = settings;
    this.prepare = prepare; // wird mit dem nächsten Foto aufgerufen, um es vorab aufzubereiten
    this.list = [];
    this.pos = -1;
    this.key = null;
    this.current = null;
    this.shownAt = Date.now();
    this.paused = false;
    this.seq = 0;
    this.transition = "fade";
    this.kenBurns = { x: 0, y: 0, zoomIn: true };
    this.timer = null;
  }

  matches(photo, s) {
    if (s.allFolders) return true;
    return s.folders.some((f) => photo.dir === f || photo.dir.startsWith(f + "/"));
  }

  sortIds(photos, order) {
    const sorted = [...photos];
    if (order === "date_asc") sorted.sort((a, b) => a.taken - b.taken);
    else if (order === "date_desc") sorted.sort((a, b) => b.taken - a.taken);
    else if (order === "name") sorted.sort((a, b) => a.rel.localeCompare(b.rel, "de", { numeric: true }));
    const ids = sorted.map((p) => p.id);
    return order === "shuffle" ? shuffle(ids) : ids;
  }

  // Wiedergabeliste neu aufbauen, wenn sich Auswahl, Reihenfolge oder Fotos geändert haben
  rebuild() {
    const s = this.settings.value;
    const selected = this.library.photos.filter((p) => this.matches(p, s));
    const key = `${s.order}|${s.allFolders ? "*" : [...s.folders].sort().join("\n")}`;
    const ids = new Set(selected.map((p) => p.id));
    const sameSet = ids.size === this.list.length && this.list.every((id) => ids.has(id));
    if (this.current) this.current = this.library.byId.get(this.current.id) || this.current;

    if (key === this.key && sameSet) return;

    const currentId = this.current?.id;
    if (key === this.key && s.order === "shuffle") {
      // Nur Fotos haben sich geändert: Reihenfolge behalten, neue Fotos direkt als Nächstes zeigen
      const known = new Set(this.list);
      const fresh = shuffle(selected.filter((p) => !known.has(p.id)).map((p) => p.id));
      const before = this.list.slice(0, this.pos + 1).filter((id) => ids.has(id));
      const after = this.list.slice(this.pos + 1).filter((id) => ids.has(id));
      this.list = [...before, ...fresh, ...after];
      this.pos = before.length - 1;
    } else {
      this.list = this.sortIds(selected, s.order);
      if (s.order === "shuffle" && ids.has(currentId)) {
        this.list = [currentId, ...this.list.filter((id) => id !== currentId)];
      }
      this.pos = this.list.indexOf(currentId);
    }
    this.key = key;
    this.emit("status");

    if (!this.current || !ids.has(currentId)) this.advance(1);
    else this.schedule();
  }

  advance(step) {
    clearTimeout(this.timer);
    if (!this.list.length) {
      this.current = null;
      this.seq++;
      this.emit("show", this.message());
      return;
    }

    this.pos += step;
    if (this.pos >= this.list.length) {
      if (this.settings.value.order === "shuffle" && this.list.length > 2) {
        const last = this.list[this.list.length - 1];
        shuffle(this.list);
        if (this.list[0] === last) this.list.push(this.list.shift());
      }
      this.pos = 0;
    } else if (this.pos < 0) {
      this.pos = this.list.length - 1;
    }

    this.current = this.library.byId.get(this.list[this.pos]);
    this.shownAt = Date.now();
    this.seq++;

    const s = this.settings.value;
    if (s.transition === "random") {
      const options = TRANSITIONS.filter((t) => t !== this.transition);
      this.transition = options[Math.floor(Math.random() * options.length)];
    } else {
      this.transition = s.transition;
    }
    this.kenBurns = {
      x: +(Math.random() * 6 - 3).toFixed(2),
      y: +(Math.random() * 6 - 3).toFixed(2),
      zoomIn: Math.random() < 0.6,
    };

    const next = this.peekNext();
    if (next) this.prepare(next);

    this.emit("show", this.message());
    this.schedule();
  }

  peekNext() {
    if (this.list.length < 2) return null;
    return this.library.byId.get(this.list[(this.pos + 1) % this.list.length]);
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.paused || this.list.length < 2) return;
    const remaining = Math.max(1000, this.settings.value.interval * 1000 - (Date.now() - this.shownAt));
    this.timer = setTimeout(() => this.advance(1), remaining);
  }

  setPaused(paused) {
    this.paused = paused;
    if (paused) {
      clearTimeout(this.timer);
    } else {
      this.shownAt = Date.now(); // nach der Pause bekommt das Bild wieder die volle Anzeigezeit
      this.schedule();
    }
    this.emit("pause", { paused });
  }

  photoInfo(p) {
    return {
      id: p.id,
      url: `/img/${p.id}?v=${p.mtime}`,
      name: p.name,
      folder: p.dir,
      taken: p.taken,
      exifDate: p.exifDate,
    };
  }

  message() {
    const next = this.peekNext();
    return {
      seq: this.seq,
      photo: this.current ? this.photoInfo(this.current) : null,
      next: next ? { url: this.photoInfo(next).url } : null,
      transition: this.transition,
      kenBurns: this.kenBurns,
      paused: this.paused,
      elapsed: Date.now() - this.shownAt,
      position: this.pos + 1,
      total: this.list.length,
    };
  }
}

module.exports = { Slideshow };
