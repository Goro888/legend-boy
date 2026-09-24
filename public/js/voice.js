// Voice: microphone recording with voice-activity detection + text-to-speech playback queue.
import * as api from "./api.js";
import { settings } from "./store.js";
import { toSpeech } from "./markdown.js";

let audioCtx = null;
// Tiny silent WAV used to unlock the audio element inside a user gesture (iOS).
const SILENT_WAV = (() => {
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  let bin = ""; new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return "data:audio/wav;base64," + btoa(bin);
})();

export const audioEl = new Audio();
audioEl.playsInline = true;
audioEl.preload = "auto";

/** Must be called from a user gesture (tap) — unlocks audio on iOS/Android. */
export function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
  try {
    audioEl.src = SILENT_WAV;
    const p = audioEl.play();
    if (p) p.catch(() => {});
  } catch {}
  try {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {}
}

/* ================================================================== */
/* Recorder                                                            */
/* ================================================================== */

let micStream = null;

export async function getMic() {
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === "live")) return micStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone is not supported in this browser.");
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  return micStream;
}

export function releaseMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
}

function pickMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
  if (!window.MediaRecorder) return null;
  for (const t of types) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return "";
}

export class Recorder {
  constructor({ onLevel, onSpeech } = {}) {
    this.onLevel = onLevel || (() => {});
    this.onSpeech = onSpeech || (() => {});
    this.active = false;
  }

  /**
   * Start recording. Resolves with {blob, filename} when stopped, or null when cancelled / no speech.
   * opts.vad: auto-stop after silence
   */
  async start({ vad = true, silenceMs = 1300, maxMs = 45000, noSpeechMs = 9000 } = {}) {
    if (this.active) return null;
    const stream = await getMic();
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});

    const mime = pickMime();
    if (mime === null) throw new Error("Recording is not supported in this browser.");
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    this.active = true;
    this.cancelled = false;
    this.forceKeep = false;
    let spoke = false;
    let speechMs = 0;
    let lastVoice = performance.now();
    const t0 = performance.now();
    let floor = 0.008;
    let frames = 0;

    return new Promise((resolve) => {
      let raf;
      const finish = async () => {
        cancelAnimationFrame(raf);
        try { source.disconnect(); } catch {}
        this.onLevel(0);
        this.active = false;
        if (this.cancelled || (vad && !spoke && !this.forceKeep) || !chunks.length) return resolve(null);
        const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
        resolve(await toWav(blob));
      };
      rec.onstop = finish;

      this._stop = () => {
        if (rec.state !== "inactive") rec.stop();
      };

      const tick = () => {
        if (!this.active) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        frames++;
        if (frames < 20) floor = Math.max(floor, rms * 0.9); // quick noise-floor estimate (first ~300ms)
        const threshold = Math.max(0.018, floor * 2.2);
        this.onLevel(Math.min(1, rms / 0.15));

        if (rms > threshold) {
          speechMs += 16;
          lastVoice = now;
          if (!spoke && speechMs > 180) {
            spoke = true;
            this.onSpeech();
          }
        }

        if (vad) {
          if (spoke && now - lastVoice > silenceMs) return this._stop();
          if (!spoke && now - t0 > noSpeechMs) return this._stop();
        }
        if (now - t0 > maxMs) return this._stop();
        raf = requestAnimationFrame(tick);
      };

      rec.start(250);
      raf = requestAnimationFrame(tick);
    });
  }

  /** Stop and keep what was recorded (manual send). */
  stop() {
    this.forceKeep = true;
    if (this._stop) this._stop();
  }

  /** Stop and discard. */
  cancel() {
    this.cancelled = true;
    if (this._stop) this._stop();
  }
}

/** Convert any recorded audio to 16 kHz mono WAV (small + universally decodable). Falls back to original. */
async function toWav(blob) {
  const ext = blob.type.includes("mp4") || blob.type.includes("aac") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  try {
    const arr = await blob.arrayBuffer();
    const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(arr.slice(0), res, rej);
      if (p && p.then) p.then(res, rej);
    });
    const rate = 16000;
    const length = Math.ceil(decoded.duration * rate);
    const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, length, rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const data = rendered.getChannelData(0);
    const wav = new ArrayBuffer(44 + data.length * 2);
    const v = new DataView(wav);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + data.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, data.length * 2, true);
    let o = 44;
    for (let i = 0; i < data.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, data[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return { blob: new Blob([wav], { type: "audio/wav" }), filename: "speech.wav" };
  } catch (e) {
    console.warn("wav conversion failed, sending original", e);
    return { blob, filename: `speech.${ext}` };
  }
}

/* ================================================================== */
/* Speaker (TTS queue)                                                 */
/* ================================================================== */

let cloudFailures = 0;

function pickDeviceVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const lang = settings.lang && settings.lang !== "auto" ? settings.lang : (navigator.language || "en").slice(0, 2);
  const inLang = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang));
  const pool = inLang.length ? inLang : voices.filter((v) => v.lang?.startsWith("en"));
  const male = pool.find((v) => /male|daniel|alex|aaron|arthur|fred|guy|james|oliver|rishi|google uk english male/i.test(v.name) && !/female/i.test(v.name));
  return male || pool.find((v) => v.default) || pool[0] || voices[0];
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

export class Speaker {
  constructor({ onStart, onEnd } = {}) {
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});
    this.queue = []; // [{text, audioPromise}]
    this.playing = false;
    this.gen = 0;
    this.idleResolvers = [];
  }

  get useCloud() {
    return settings.engine !== "device" && cloudFailures < 3;
  }

  enqueue(rawText) {
    const text = toSpeech(rawText);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    const item = { text, gen: this.gen };
    if (this.useCloud) {
      item.audio = api.tts(text).catch((e) => {
        console.warn("cloud tts failed", e);
        cloudFailures++;
        return null;
      });
    }
    this.queue.push(item);
    if (!this.playing) this._next();
  }

  async _next() {
    const item = this.queue.shift();
    if (!item) {
      if (this.playing) {
        this.playing = false;
        this.onEnd();
      }
      this.idleResolvers.splice(0).forEach((r) => r());
      return;
    }
    if (!this.playing) {
      this.playing = true;
      this.onStart();
    }
    const myGen = this.gen;
    try {
      const blob = item.audio ? await item.audio : null;
      if (myGen !== this.gen) return;
      if (blob) await this._playBlob(blob);
      else await this._speakDevice(item.text);
    } catch (e) {
      console.warn("playback failed", e);
      if (myGen === this.gen) await this._speakDevice(item.text).catch(() => {});
    }
    if (myGen === this.gen) this._next();
  }

  _playBlob(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const done = () => {
        audioEl.onended = audioEl.onerror = audioEl.onpause = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      audioEl.onended = done;
      audioEl.onerror = done;
      audioEl.src = url;
      const p = audioEl.play();
      if (p) p.catch((e) => { console.warn(e); done(); });
      this._cancelCurrent = () => { audioEl.pause(); done(); };
    });
  }

  _speakDevice(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickDeviceVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1.03;
      u.pitch = 1.0;
      const timer = setTimeout(resolve, Math.max(4000, text.length * 110)); // safety for buggy engines
      u.onend = u.onerror = () => { clearTimeout(timer); resolve(); };
      speechSynthesis.speak(u);
      this._cancelCurrent = () => { speechSynthesis.cancel(); clearTimeout(timer); resolve(); };
    });
  }

  /** Resolves when everything queued has been spoken. */
  whenIdle() {
    if (!this.playing && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  stop() {
    this.gen++;
    this.queue = [];
    try { this._cancelCurrent?.(); } catch {}
    try { audioEl.pause(); } catch {}
    try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch {}
    if (this.playing) {
      this.playing = false;
      this.onEnd();
    }
    this.idleResolvers.splice(0).forEach((r) => r());
  }
}

/**
 * Splits streaming text into speakable chunks at sentence boundaries.
 * Skips fenced code blocks.
 */
export class SentenceStream {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.full = "";
    this.pos = 0;
    this.first = true;
  }
  push(delta) {
    this.full += delta;
    this._drain(false);
  }
  end() {
    this._drain(true);
  }
  _drain(final) {
    let text = this.full.slice(this.pos);
    // don't speak inside an unclosed code fence
    const fences = (this.full.slice(0, this.pos).match(/```/g) || []).length;
    if (fences % 2 === 1) {
      const close = text.indexOf("```");
      if (close < 0) return;
      this.pos += close + 3;
      return this._drain(final);
    }
    const open = text.indexOf("```");
    if (open === 0) {
      this.pos += 3; // enter code block (skipped until it closes)
      return this._drain(final);
    }
    let limit = open >= 0 ? open : text.length;
    const region = text.slice(0, limit);
    const min = this.first ? 24 : 70;
    let cut = -1;
    const re = /[.!?。！？…]["')\]]*(?=\s|$)|\n+/g;
    let m;
    while ((m = re.exec(region))) {
      const end = m.index + m[0].length;
      if (end >= min && (end < region.length || final || m[0].startsWith("\n"))) {
        cut = end;
        if (end >= 220) break;
      }
    }
    if (cut < 0 && final) cut = region.length;
    if (cut < 0 && region.length > 300) {
      const sp = region.lastIndexOf(" ", 280);
      cut = sp > 50 ? sp : 280;
    }
    if (cut > 0) {
      const chunk = region.slice(0, cut);
      this.pos += cut;
      this.first = false;
      if (chunk.trim()) this.onChunk(chunk);
      return this._drain(final);
    }
    if (final && open >= 0) {
      this.pos += open + 3;
      return this._drain(final);
    }
  }
}
