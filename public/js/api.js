// Tiny API client for the Legend Boy Worker.
import { settings } from "./store.js";

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function headers(extra = {}) {
  const h = { ...extra };
  if (settings.code) h["x-access-code"] = settings.code;
  return h;
}

async function asError(res) {
  let msg = `Request failed (${res.status})`;
  let code;
  try {
    const j = await res.json();
    msg = j.error || msg;
    code = j.code;
  } catch {}
  return new ApiError(msg, res.status, code);
}

export async function health() {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) throw await asError(res);
  return res.json();
}

/**
 * POST JSON and consume the server-sent-event stream.
 * onEvent receives parsed objects: {type:"token"|"status"|"sources"|"queries"|"error"|"done", ...}
 */
export async function stream(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await asError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {}
      }
    }
  }
}

export async function transcribe(blob, filename = "speech.wav") {
  const fd = new FormData();
  fd.append("audio", blob, filename);
  if (settings.lang && settings.lang !== "auto") fd.append("language", settings.lang);
  const res = await fetch("/api/transcribe", { method: "POST", headers: headers(), body: fd });
  if (!res.ok) throw await asError(res);
  return res.json();
}

export async function tts(text, signal) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ text, speaker: settings.speaker }),
    signal,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw await asError(res);
  const blob = await res.blob();
  return blob.size > 0 ? blob : null;
}

export async function extract(file) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch("/api/extract", { method: "POST", headers: headers(), body: fd });
  if (!res.ok) throw await asError(res);
  return res.json();
}

export async function imagine(prompt) {
  const res = await fetch("/api/imagine", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw await asError(res);
  return res.json();
}
