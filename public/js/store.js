// Local persistence (settings + chats) using localStorage.
const K_SETTINGS = "lb.settings.v1";
const K_CHATS = "lb.chats.v1";
const K_AVATAR = "lb.avatar.v1";
const K_RESEARCH = "lb.research.v1";

export const DEFAULT_AVATAR = "/img/legend-boy.jpg";

const defaults = {
  name: "",
  engine: "cloud", // cloud | device
  speaker: "apollo",
  lang: "auto",
  autoSpeak: false,
  greet: true,
  code: "",
  handsFree: true,
  muted: false,
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn("storage full", e);
    return false;
  }
}

export const settings = { ...defaults, ...read(K_SETTINGS, {}) };
export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  write(K_SETTINGS, settings);
}

/* ---------- Avatar ---------- */
export function getAvatar() {
  try {
    return localStorage.getItem(K_AVATAR) || DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}
export function setAvatar(dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(K_AVATAR, dataUrl);
    else localStorage.removeItem(K_AVATAR);
    return true;
  } catch {
    return false;
  }
}

/* ---------- Chats ---------- */
// chat = { id, title, updated, messages: [{ id, role, content, images:[thumbDataUrl], files:[{name,size,text}], gen?:bool }] }
let chats = read(K_CHATS, []);
if (!Array.isArray(chats)) chats = [];

export function listChats() {
  return [...chats].sort((a, b) => b.updated - a.updated);
}
export function getChat(id) {
  return chats.find((c) => c.id === id);
}
export function newChat() {
  const c = { id: uid(), title: "New chat", updated: Date.now(), messages: [] };
  chats.push(c);
  return c;
}
export function deleteChat(id) {
  chats = chats.filter((c) => c.id !== id);
  persistChats();
}
export function clearChats() {
  chats = [];
  persistChats();
}
export function persistChats() {
  // Drop empty chats, cap at 50 chats; if storage is full, trim oldest.
  let list = chats.filter((c) => c.messages.length).sort((a, b) => b.updated - a.updated).slice(0, 50);
  const slim = (arr) =>
    arr.map((c) => ({
      ...c,
      messages: c.messages.slice(-80).map((m) => ({
        ...m,
        files: (m.files || []).map((f) => ({ name: f.name, size: f.size, text: (f.text || "").slice(0, 30000) })),
      })),
    }));
  while (list.length && !write(K_CHATS, slim(list))) {
    // Remove images from the oldest chat first, then drop chats.
    const oldest = list[list.length - 1];
    const hasImg = oldest.messages.some((m) => m.images?.length);
    if (hasImg) oldest.messages.forEach((m) => (m.images = []));
    else list = list.slice(0, -1);
  }
  if (!list.length) write(K_CHATS, []);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- Research ---------- */
export function getLastResearch() {
  return read(K_RESEARCH, null);
}
export function saveLastResearch(r) {
  write(K_RESEARCH, r);
}
