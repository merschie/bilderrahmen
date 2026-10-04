const fs = require("fs");

const TRANSITIONS = ["fade", "slide", "zoom", "blur", "rise", "rotate"];
const ORDERS = ["shuffle", "date_desc", "date_asc", "name"];

const DEFAULTS = {
  mode: "photos", // photos | tv
  tvHost: process.env.TV_HOST || "", // Fritz!Box mit Kabel-/DVB-T-Tuner, z. B. 192.168.178.1
  tvChannel: "", // "HD:Das Erste HD"
  tvSound: true,
  allFolders: true,
  folders: [],
  order: "shuffle",
  interval: 20, // Sekunden
  transition: "random", // eine aus TRANSITIONS oder "random"
  transitionDuration: 1.6, // Sekunden
  kenBurns: true,
  fit: "contain", // contain | cover
  background: "blur", // blur | black
  showClock: true,
  showInfo: true,
};

function clamp(n, min, max, fallback) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// "http://192.168.178.1/" -> "192.168.178.1"
function cleanHost(value) {
  const host = String(value || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  return /^[\w.\-:\[\]]{0,200}$/.test(host) ? host : "";
}

function sanitize(input, base = DEFAULTS) {
  const s = { ...base, ...input };
  return {
    mode: s.mode === "tv" ? "tv" : "photos",
    tvHost: cleanHost(s.tvHost),
    tvChannel: typeof s.tvChannel === "string" ? s.tvChannel.slice(0, 200) : "",
    tvSound: Boolean(s.tvSound),
    allFolders: Boolean(s.allFolders),
    folders: Array.isArray(s.folders) ? [...new Set(s.folders.filter((f) => typeof f === "string" && f))] : [],
    order: ORDERS.includes(s.order) ? s.order : DEFAULTS.order,
    interval: Math.round(clamp(s.interval, 3, 86400, DEFAULTS.interval)),
    transition: s.transition === "random" || TRANSITIONS.includes(s.transition) ? s.transition : DEFAULTS.transition,
    transitionDuration: clamp(s.transitionDuration, 0.3, 5, DEFAULTS.transitionDuration),
    kenBurns: Boolean(s.kenBurns),
    fit: s.fit === "cover" ? "cover" : "contain",
    background: s.background === "black" ? "black" : "blur",
    showClock: Boolean(s.showClock),
    showInfo: Boolean(s.showInfo),
  };
}

class Settings {
  constructor(file) {
    this.file = file;
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* erste Nutzung */ }
    this.value = sanitize(stored);
  }

  update(input) {
    this.value = sanitize(input, this.value);
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file);
    return this.value;
  }
}

module.exports = { Settings, TRANSITIONS };
