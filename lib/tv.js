// Live-Fernsehen von einer Fritz!Box mit Kabel- (DVB-C) oder DVB-T-Tuner.
// Die Fritz!Box liefert RTSP-Streams, die Browser nicht abspielen können. ffmpeg wandelt sie in HLS um:
// HD-Sender (H.264, progressiv) werden direkt durchgereicht, SD-Sender (Halbbilder) neu kodiert.
// Es läuft immer höchstens ein Stream – alle Rahmen sehen denselben Sender.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const HLS_ROOT = process.env.TV_DIR || "/dev/shm/bilderrahmen-tv"; // im RAM, schont die SSD
const LISTS = [["tvhd", "HD"], ["tvsd", "SD"]];
const CHANNEL_CACHE_MS = 10 * 60 * 1000;
const IDLE_STOP_MS = 60 * 1000; // Tuner freigeben, wenn niemand mehr zuschaut
const RETRY_DELAYS = [3000, 10000, 30000];

function parseM3u(text, group) {
  const channels = [];
  let name = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) name = line.slice(line.indexOf(",") + 1).trim();
    else if (line && !line.startsWith("#") && name) {
      channels.push({ key: `${group}:${name}`, name, group, url: line });
      name = null;
    }
  }
  return channels;
}

// Liest aus der ffmpeg-Ausgabe, welche Spuren der Sender in dieser Verbindung hat, z. B.
//   Stream #0:3(deu): Audio: ac3, 48000 Hz, stereo, fltp, 448 kb/s (visual impaired)
//   Stream #0:2: Video: h264 (High) (...), yuv420p(tv, bt470bg, top first), 720x576 [SAR 64:45 DAR 16:9]
function readInputStreams(proc, pipeline, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const streams = [];
    let buffer = "";
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(streams); } };
    const timer = setTimeout(finish, timeoutMs);
    proc.on("exit", finish);
    proc.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!/PPS|decode_slice|no frame|mmco|reference|Last message|corrupt|mismatch/.test(line)) pipeline.lastError = line.trim();
        if (done) continue;
        if (line.startsWith("Stream mapping:")) { finish(); continue; }
        const m = line.match(/^\s*Stream #0:(\d+)(?:\[0x[0-9a-f]+\])?(?:\((\w+)\))?: (Video|Audio): (\w+)(.*)$/);
        if (m) {
          streams.push({
            index: Number(m[1]),
            lang: m[2] || "",
            type: m[3],
            codec: m[4],
            interlaced: /top first|bottom first|top coded|bottom coded/.test(m[5]),
            height: Number((m[5].match(/, \d{2,5}x(\d{2,5})/) || [])[1]) || 0,
            special: /visual impaired|hearing impaired/.test(m[5]), // Audiodeskription, Klare Sprache
          });
        }
      }
    });
  });
}

class Tv extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.channels = [];
    this.channelsHost = null;
    this.channelsAt = 0;
    this.channelsError = null;
    this.proc = null;
    this.session = null;
    this.channel = null;
    this.state = "off"; // off | starting | playing | error
    this.message = "";
    this.transcode = false;
    this.viewers = 0;
    this.idleUntil = 0;
    this.gen = 0;
    this.retries = 0;
    this.retryTimer = null;
    this.queue = Promise.resolve();
    this.stopping = Promise.resolve();
    fs.rmSync(HLS_ROOT, { recursive: true, force: true });
    fs.mkdirSync(HLS_ROOT, { recursive: true });
  }

  static get root() {
    return HLS_ROOT;
  }

  host() {
    return this.settings.value.tvHost;
  }

  async loadChannels(force = false) {
    const host = this.host();
    if (!host) {
      this.channels = [];
      this.channelsError = "Keine Fritz!Box-Adresse eingetragen.";
      return this.channels;
    }
    const fresh = host === this.channelsHost && Date.now() - this.channelsAt < CHANNEL_CACHE_MS;
    if (!force && fresh && this.channels.length) return this.channels;
    try {
      const lists = await Promise.all(LISTS.map(async ([file, group]) => {
        const res = await fetch(`http://${host}/dvb/m3u/${file}.m3u`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseM3u(await res.text(), group);
      }));
      this.channels = lists.flat();
      this.channelsHost = host;
      this.channelsAt = Date.now();
      this.channelsError = this.channels.length
        ? null
        : "Die Fritz!Box liefert keine Sender. Wurde dort ein Sendersuchlauf gemacht?";
    } catch (e) {
      this.channelsError = `Fritz!Box unter ${host} nicht erreichbar (${e.cause?.code || e.message}).`;
      if (host !== this.channelsHost) this.channels = [];
    }
    return this.channels;
  }

  info() {
    const s = this.settings.value;
    return {
      active: s.mode === "tv",
      state: this.state,
      message: this.message,
      channel: this.channel && { key: this.channel.key, name: this.channel.name, group: this.channel.group },
      url: this.state === "playing" ? `/tv/${this.session}/index.m3u8` : null,
      transcode: this.transcode,
    };
  }

  setState(state, message = "") {
    this.state = state;
    this.message = message;
    this.emit("state", this.info());
  }

  wanted() {
    const s = this.settings.value;
    return s.mode === "tv" && Boolean(s.tvChannel) && (this.viewers > 0 || Date.now() < this.idleUntil);
  }

  setViewers(n) {
    const before = this.viewers;
    this.viewers = n;
    if (n === 0 && before > 0) {
      this.idleUntil = Date.now() + IDLE_STOP_MS;
      setTimeout(() => this.update(), IDLE_STOP_MS + 100);
    } else if (n > 0 && before === 0) {
      this.update();
    }
  }

  // Abgleich zwischen gewünschtem und tatsächlichem Zustand (nacheinander, nie parallel)
  update() {
    // Anderer Sender gewünscht: laufenden Start sofort abbrechen statt ihn abzuwarten
    if (this.proc && this.channel?.key !== this.settings.value.tvChannel) this.stop();
    this.queue = this.queue.then(() => this.reconcile()).catch((e) => console.error("TV:", e));
    return this.queue;
  }

  async reconcile() {
    const s = this.settings.value;
    if (!this.wanted()) {
      clearTimeout(this.retryTimer);
      await this.stop();
      if (s.mode !== "tv") this.setState("off");
      else if (!s.tvChannel) this.setState("off", "Bitte in den Einstellungen einen Sender auswählen.");
      else this.setState("off", "Pausiert – kein Rahmen verbunden.");
      return;
    }
    const running = this.proc && this.channel?.key === s.tvChannel && this.channelsHost === s.tvHost;
    if (running) return;

    await this.stop();
    await this.loadChannels();
    const channel = this.channels.find((c) => c.key === s.tvChannel);
    if (!channel) {
      this.channel = null;
      this.setState("error", this.channelsError || "Der ausgewählte Sender ist nicht mehr in der Senderliste.");
      this.scheduleRetry();
      return;
    }
    await this.start(channel);
  }

  // Zwei Stufen, weil die Fritz!Box die Spuren bei jedem RTSP-Aufruf in anderer Reihenfolge liefert
  // und keine PIDs mitschickt: Stufe 1 empfängt den Sender und meldet, welche Spur in dieser
  // Verbindung wo liegt. Stufe 2 bekommt die Daten per Pipe und wählt gezielt Bild und Hauptton.
  async start(channel) {
    const gen = ++this.gen;
    this.channel = channel;
    this.setState("starting", `${channel.name} wird eingeschaltet …`);

    const ingest = spawn("ffmpeg", [
      "-hide_banner", "-nostats", "-loglevel", "info",
      "-rtsp_transport", "udp", "-buffer_size", "4194304",
      "-fflags", "+genpts+discardcorrupt", "-analyzeduration", "3000000", "-probesize", "5000000",
      "-i", channel.url,
      "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-f", "mpegts", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const pipeline = { procs: [ingest], lastError: "" };
    this.proc = pipeline;

    const fail = (message) => {
      if (this.proc !== pipeline) return; // absichtlich beendet oder schon behandelt
      this.proc = null;
      for (const p of pipeline.procs) p.kill("SIGTERM");
      console.warn(`TV: ${message} ${pipeline.lastError}`);
      this.setState("error", message);
      this.scheduleRetry();
    };
    ingest.on("exit", () => fail(`Der Empfang von ${channel.name} wurde unterbrochen. Neuer Versuch …`));

    const streams = await readInputStreams(ingest, pipeline);
    if (gen !== this.gen || this.proc !== pipeline) return;

    // Stufe 1 gibt erst alle Bild-, dann alle Tonspuren aus, jeweils in Eingangsreihenfolge
    const video = streams.find((st) => st.type === "Video");
    const audios = streams.filter((st) => st.type === "Audio").sort((a, b) => a.index - b.index);
    if (!video) {
      fail(`${channel.name}: Kein Bild empfangen. Sind alle Tuner der Fritz!Box belegt oder ist der Sender verschlüsselt?`);
      return;
    }
    const regular = audios.filter((a) => !a.special);
    const audio = regular.find((a) => ["deu", "ger"].includes(a.lang)) || regular[0] || audios[0];

    // HD (H.264, progressiv) direkt durchreichen, alles andere entflechten und neu kodieren.
    // SD wird immer mit Halbbildern gesendet – die Angabe dazu fehlt aber manchmal in der Analyse.
    const sd = channel.group === "SD" || (video.height > 0 && video.height < 720);
    this.transcode = video.codec !== "h264" || video.interlaced || sd;
    const videoArgs = this.transcode
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
        "-g", "50", "-keyint_min", "50", "-sc_threshold", "0",
        "-vf", "yadif=0,scale=trunc(iw*sar/2)*2:ih,setsar=1",
        "-fps_mode", "passthrough"] // Zeitstempel übernehmen, sonst vervielfacht ffmpeg 8 Bilder
      : ["-c:v", "copy"];

    this.session = crypto.randomBytes(6).toString("hex");
    const dir = path.join(HLS_ROOT, this.session);
    fs.mkdirSync(dir, { recursive: true });

    const encoder = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-fflags", "+genpts+discardcorrupt", "-analyzeduration", "5000000", "-probesize", "10000000",
      "-f", "mpegts", "-i", "pipe:0",
      "-map", "0:v:0", ...(audio ? ["-map", `0:a:${audios.indexOf(audio)}`] : []),
      ...videoArgs,
      "-c:a", "aac", "-b:a", "160k", "-ac", "2",
      "-max_muxing_queue_size", "1024",
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
      "-hls_flags", "delete_segments+independent_segments+omit_endlist+temp_file",
      "-hls_segment_filename", path.join(dir, "seg_%06d.ts"),
      path.join(dir, "index.m3u8"),
    ], { stdio: ["pipe", "ignore", "pipe"] });
    pipeline.procs.push(encoder);
    encoder.stdin.on("error", () => {}); // Pipe bricht beim Umschalten ab – kein Fehler
    ingest.stdout.pipe(encoder.stdin);
    encoder.stderr.on("data", (d) => {
      const line = d.toString().trim().split("\n").pop();
      if (line) pipeline.lastError = line;
    });
    console.log(`TV: ${channel.name} (${this.transcode ? "wird umgerechnet" : "direkt"}, Ton: ${audio?.lang || "?"})`);

    // Bereit, sobald genug Segmente für flüssiges Abspielen da sind
    const playlist = path.join(dir, "index.m3u8");
    const ready = setInterval(() => {
      if (this.proc !== pipeline) return clearInterval(ready);
      let text = "";
      try { text = fs.readFileSync(playlist, "utf8"); } catch { return; }
      if ((text.match(/#EXTINF/g) || []).length >= 2) {
        clearInterval(ready);
        this.retries = 0;
        this.setState("playing");
      }
    }, 500);

    encoder.on("exit", () => {
      clearInterval(ready);
      fs.rmSync(dir, { recursive: true, force: true });
      fail(`Der Empfang von ${channel.name} wurde unterbrochen. Neuer Versuch …`);
    });
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)];
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.channel = null; // erzwingt Neustart
      this.update();
    }, delay);
  }

  stop() {
    this.gen++;
    const pipeline = this.proc;
    if (!pipeline) return this.stopping;
    this.proc = null;
    // SIGTERM, damit ffmpeg der Fritz!Box ein TEARDOWN schickt und der Tuner frei wird
    this.stopping = Promise.all(pipeline.procs.map((proc) => new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const kill = setTimeout(() => proc.kill("SIGKILL"), 5000);
      proc.once("exit", () => { clearTimeout(kill); resolve(); });
      proc.kill("SIGTERM");
    })));
    return this.stopping;
  }

  // Nächster/vorheriger Sender in der Liste
  async neighbour(step) {
    const list = await this.loadChannels();
    if (!list.length) return null;
    const i = list.findIndex((c) => c.key === this.settings.value.tvChannel);
    return list[(i + step + list.length) % list.length].key;
  }
}

module.exports = { Tv };
