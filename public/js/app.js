// Legend Boy — main app
import * as api from "./api.js";
import * as store from "./store.js";
import { settings, saveSettings } from "./store.js";
import { renderMarkdown } from "./markdown.js";
import { Recorder, Speaker, SentenceStream, unlockAudio, releaseMic } from "./voice.js";
import { Camera, cameraErrorMessage } from "./camera.js";
import * as media from "./media.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ================================================================== */
/* State                                                               */
/* ================================================================== */
const state = {
  view: "chat",
  chat: null,
  busy: false,
  controller: null,
  pending: [], // attachments waiting in composer
  fullImages: new Map(), // msgId -> [full-size data URLs] (memory only)
  library: [],
  server: null,
  researchDepth: "quick",
  research: null,
};

const ICONS = {
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>',
  speak: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7l-6.7 3.4a3 3 0 1 0 0 3.2L15 17a3 3 0 1 0 3-1Z"/></svg>',
};

/* ================================================================== */
/* Utilities                                                           */
/* ================================================================== */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function greetingText() {
  const h = new Date().getHours();
  const part = h < 5 ? "Hey night owl" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}${settings.name ? ", " + settings.name : ""}!`;
}

function vibrate(ms = 10) {
  try { navigator.vibrate?.(ms); } catch {}
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied ✓");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Copied ✓");
  }
}

function applyAvatar() {
  const src = store.getAvatar();
  $$(".avatar-img").forEach((img) => (img.src = src));
}

function setStatus(text, cls = "") {
  const el = $("#statusText");
  el.className = "status " + cls;
  el.innerHTML = `<i class="dot"></i>${escapeHtml(text)}`;
}

function friendlyErr(e) {
  if (e?.code === "ACCESS_CODE") {
    setTimeout(() => openSettings(true), 400);
    return "This app is locked. Enter your access code in Settings.";
  }
  if (!navigator.onLine) return "You're offline. Check your internet connection.";
  return e?.message || String(e);
}

/* ================================================================== */
/* Speaker (shared)                                                    */
/* ================================================================== */
const speaker = new Speaker({
  onStart: () => { if (talk.on || talk.greeting) setOrb("speaking"); },
  onEnd: () => { if (!talk.on && !talk.greeting) setOrb("idle"); },
});

/* ================================================================== */
/* Splash                                                              */
/* ================================================================== */
function initSplash() {
  const g = $("#splashGreet");
  g.textContent = `${greetingText()} I'm your legendary AI assistant.`;

  const enter = (to) => {
    unlockAudio();
    vibrate(15);
    $("#splash").classList.add("leaving");
    $("#app").hidden = false;
    setTimeout(() => ($("#splash").hidden = true), 500);
    showView(to);
    if (to === "talk") greetInTalk();
  };
  const startView = new URLSearchParams(location.search).get("view");
  const valid = ["chat", "talk", "camera", "files", "research"];
  $("#splashStart").onclick = () => enter(valid.includes(startView) ? startView : "talk");
  $("#splashSkip").onclick = () => enter("chat");
}

async function greetInTalk() {
  const line = `${greetingText()} I'm Legend Boy. I can chat, see through your camera, read your files and research anything. What can I do for you?`;
  $("#capUser").textContent = "";
  $("#capBot").textContent = line;
  if (!settings.greet || settings.muted) {
    setTalkState("idle");
    return;
  }
  talk.greeting = true;
  setOrb("speaking");
  $("#talkState").textContent = "Speaking…";
  speaker.enqueue(line);
  await speaker.whenIdle();
  talk.greeting = false;
  if (talk.on) return;
  setTalkState("idle");
  // Start listening automatically if microphone permission was already granted.
  try {
    const p = await navigator.permissions?.query({ name: "microphone" });
    if (p?.state === "granted" && state.view === "talk") startTalk();
  } catch {}
}

/* ================================================================== */
/* Views / navigation                                                  */
/* ================================================================== */
function showView(name) {
  if (state.view === "camera" && name !== "camera") cam.stop();
  if (state.view === "talk" && name !== "talk") stopTalk();
  state.view = name;
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.go === name));
  if (name === "camera") startCamera();
  if (name === "chat") scrollToBottom(true);
}

function initTabs() {
  $$(".tab").forEach((t) => (t.onclick = () => { vibrate(); showView(t.dataset.go); }));
}

/* ================================================================== */
/* Chat rendering                                                      */
/* ================================================================== */
const messagesEl = () => $("#messages");

function nearBottom() {
  const el = messagesEl();
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}
function scrollToBottom(force = false) {
  const el = messagesEl();
  if (force || nearBottom()) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
}

function renderWelcome() {
  const el = messagesEl();
  el.innerHTML = `
    <div class="welcome">
      <div class="avatar-orb" data-state="idle"><span class="ring r1"></span><span class="ring r2"></span>
        <img class="avatar-img" src="${escapeHtml(store.getAvatar())}" alt="Legend Boy" /></div>
      <h2>${escapeHtml(greetingText())}</h2>
      <p>I'm Legend Boy. Ask me anything — or show me something.</p>
      <div class="suggest">
        <button data-go="camera"><b>📸</b>Point your camera and ask me about it</button>
        <button data-go="talk"><b>🎙️</b>Talk to me with your voice</button>
        <button data-q="Give me 5 creative business ideas I can start with under $100."><b>💡</b>Business ideas under $100</button>
        <button data-go="research"><b>🔎</b>Deep research with sources</button>
        <button data-q="Write a catchy Instagram caption for a sunset photo at the beach."><b>✍️</b>Write me a cool caption</button>
        <button data-imagine="1"><b>🎨</b>Create an image from words</button>
      </div>
    </div>`;
  $$(".suggest button", el).forEach((b) => {
    b.onclick = () => {
      if (b.dataset.go) showView(b.dataset.go);
      else if (b.dataset.q) sendFromComposer(b.dataset.q);
      else if (b.dataset.imagine) openSheet("imagineSheet");
    };
  });
}

function renderChat() {
  const el = messagesEl();
  if (!state.chat || !state.chat.messages.length) return renderWelcome();
  el.innerHTML = "";
  state.chat.messages.forEach((m) => el.appendChild(messageEl(m)));
  scrollToBottom(true);
}

function messageEl(m) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${m.role === "user" ? "user" : "bot"}`;
  wrap.dataset.id = m.id;
  if (m.role !== "user") {
    wrap.innerHTML = `<img class="m-avatar avatar-img" src="${escapeHtml(store.getAvatar())}" alt="" />`;
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  wrap.appendChild(bubble);
  fillBubble(bubble, m);
  return wrap;
}

function fillBubble(bubble, m, streaming = false) {
  let html = "";
  const imgs = state.fullImages.get(m.id) || m.images || [];
  if (imgs.length) {
    html += `<div class="imgs">${imgs.map((src) => `<img src="${escapeHtml(src)}" class="${m.gen ? "gen" : ""}" alt="image" loading="lazy" />`).join("")}</div>`;
  }
  if (m.files?.length) {
    html += `<div class="files">${m.files.map((f) => `<span class="file-pill">${media.fileIcon(f.name)} <span>${escapeHtml(f.name)}</span></span>`).join("")}</div>`;
  }
  if (m.role === "user") {
    html += escapeHtml(m.content || "");
  } else if (m.error) {
    html += `<div class="err">⚠️ ${escapeHtml(m.error)}</div>`;
  } else if (!m.content && streaming) {
    html += `<div class="typing"><i></i><i></i><i></i></div>`;
  } else {
    html += `<div class="md">${renderMarkdown(m.content)}</div>`;
  }
  if (m.role !== "user" && !streaming && (m.content || m.error)) {
    const isLast = state.chat?.messages[state.chat.messages.length - 1]?.id === m.id;
    html += `<div class="m-actions">
      ${m.content ? `<button data-a="copy">${ICONS.copy}Copy</button><button data-a="speak">${ICONS.speak}Listen</button>` : ""}
      ${m.content && navigator.share ? `<button data-a="share">${ICONS.share}</button>` : ""}
      ${isLast && !m.gen ? `<button data-a="redo">${ICONS.redo}Retry</button>` : ""}
    </div>`;
  }
  bubble.innerHTML = html;

  $$(".imgs img", bubble).forEach((img) => (img.onclick = () => lightbox(img.src)));
  $$(".copy-code", bubble).forEach((b) => (b.onclick = () => copyText(b.nextElementSibling.textContent)));
  $$(".m-actions button", bubble).forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a;
      if (a === "copy") copyText(m.content);
      if (a === "speak") { speaker.stop(); speakAll(m.content); }
      if (a === "share") navigator.share({ text: m.content, title: "Legend Boy" }).catch(() => {});
      if (a === "redo") regenerate();
    };
  });
}

function speakAll(text) {
  const ss = new SentenceStream((c) => speaker.enqueue(c));
  ss.push(text);
  ss.end();
}

function lightbox(src) {
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.innerHTML = `<img src="${escapeHtml(src)}" alt="" />`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

/* ================================================================== */
/* Chats                                                               */
/* ================================================================== */
function ensureChat() {
  if (!state.chat) state.chat = store.newChat();
  return state.chat;
}

function startNewChat() {
  if (state.busy) stopGenerating();
  state.chat = null;
  state.pending = [];
  renderPending();
  renderChat();
  showView("chat");
}

function openChat(id) {
  const c = store.getChat(id);
  if (!c) return;
  state.chat = c;
  renderChat();
  closeOverlays();
  showView("chat");
}

function renderChatList() {
  const list = $("#chatList");
  const chats = store.listChats().filter((c) => c.messages.length);
  if (!chats.length) {
    list.innerHTML = `<div class="empty">No chats yet</div>`;
    return;
  }
  list.innerHTML = chats
    .map(
      (c) => `<div class="chat-item ${state.chat?.id === c.id ? "active" : ""}" data-id="${c.id}">
        <button class="ci-t" data-open="${c.id}"><strong>${escapeHtml(c.title)}</strong><small>${new Date(c.updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small></button>
        <button class="ci-del" data-del="${c.id}" aria-label="Delete">✕</button></div>`
    )
    .join("");
  $$("[data-open]", list).forEach((b) => (b.onclick = () => openChat(b.dataset.open)));
  $$("[data-del]", list).forEach(
    (b) =>
      (b.onclick = () => {
        if (!confirm("Delete this chat?")) return;
        store.deleteChat(b.dataset.del);
        if (state.chat?.id === b.dataset.del) { state.chat = null; renderChat(); }
        renderChatList();
      })
  );
}

function payloadMessages(chat) {
  return chat.messages
    .filter((m) => !m.error && (m.content || m.images?.length || m.files?.length) && !m.gen)
    .map((m) => ({
      role: m.role,
      content: m.content,
      images: m.role === "user" ? state.fullImages.get(m.id) || m.images || [] : undefined,
      files: m.files?.length ? m.files.map((f) => ({ name: f.name, text: f.text })) : undefined,
    }));
}

/**
 * Core: send a user message (text + photos + files) and stream the reply.
 * Returns the assistant's final text.
 */
async function sendMessage(text, { images = [], files = [], voice = false, onToken } = {}) {
  if (state.busy) stopGenerating();
  const chat = ensureChat();
  text = (text || "").trim();

  const thumbs = await Promise.all(images.map((src) => media.thumb(src).catch(() => src)));
  const userMsg = {
    id: store.uid(),
    role: "user",
    content: text,
    images: thumbs,
    files: files.map((f) => ({ name: f.name, size: f.size, text: f.text })),
    ts: Date.now(),
  };
  if (images.length) state.fullImages.set(userMsg.id, images);
  if (chat.title === "New chat") {
    chat.title = (text || (images.length ? "📸 Photo question" : files[0]?.name) || "Chat").slice(0, 48);
  }
  if (!chat.messages.length) messagesEl().innerHTML = "";
  chat.messages.push(userMsg);
  messagesEl().appendChild(messageEl(userMsg));
  scrollToBottom(true);
  return runAssistant({ voice, onToken });
}

async function runAssistant({ voice = false, onToken } = {}) {
  const chat = ensureChat();
  const bot = { id: store.uid(), role: "assistant", content: "", ts: Date.now() };
  const payload = payloadMessages(chat);
  chat.messages.push(bot);
  const el = messageEl(bot);
  messagesEl().appendChild(el);
  const bubble = $(".bubble", el);
  fillBubble(bubble, bot, true);
  scrollToBottom(true);

  setBusy(true);
  const controller = new AbortController();
  state.controller = controller;
  const autoSpeak = !voice && settings.autoSpeak && !settings.muted;
  const ss = autoSpeak ? new SentenceStream((c) => speaker.enqueue(c)) : null;
  let raf = 0;
  const paint = () => {
    raf = 0;
    const stick = nearBottom();
    fillBubble(bubble, bot, true);
    if (stick) messagesEl().scrollTop = messagesEl().scrollHeight;
  };

  try {
    await api.stream(
      "/api/chat",
      { messages: payload, userName: settings.name, voice },
      (ev) => {
        if (ev.type === "token") {
          bot.content += ev.text;
          onToken?.(ev.text, bot.content);
          ss?.push(ev.text);
          if (!raf) raf = requestAnimationFrame(paint);
        } else if (ev.type === "error") {
          bot.error = ev.error;
        }
      },
      controller.signal
    );
  } catch (e) {
    if (e.name === "AbortError") {
      if (!bot.content) bot.content = "_(stopped)_";
    } else {
      bot.error = friendlyErr(e);
    }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    if (state.controller === controller) {
      state.controller = null;
      setBusy(false);
    }
    ss?.end();
    if (bot.error && bot.content) {
      bot.content += `\n\n⚠️ ${bot.error}`;
      bot.error = null;
    }
    chat.updated = Date.now();
    // refresh previous "retry" buttons
    $$(".msg.bot [data-a='redo']").forEach((b) => b.remove());
    fillBubble(bubble, bot, false);
    scrollToBottom();
    store.persistChats();
  }
  return bot.error ? "" : bot.content;
}

function regenerate() {
  const chat = state.chat;
  if (!chat || state.busy) return;
  const last = chat.messages[chat.messages.length - 1];
  if (last?.role !== "assistant") return;
  chat.messages.pop();
  messagesEl().querySelector(`[data-id="${last.id}"]`)?.remove();
  runAssistant();
}

function stopGenerating() {
  state.controller?.abort();
  state.controller = null;
  setBusy(false);
}

function setBusy(b) {
  state.busy = b;
  $("#composer").classList.toggle("busy", b);
  if (b) setStatus("Thinking…", "busy");
  else setStatus(state.server?.mock ? "Online · demo mode" : "Online");
}

/* ================================================================== */
/* Composer + attachments                                              */
/* ================================================================== */
function initComposer() {
  const input = $("#input");
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    // On desktop Enter sends; on phones Enter makes a new line (send button is used)
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.busy) return stopGenerating();
    sendFromComposer();
  });
  $("#btnAttach").onclick = () => openSheet("attachSheet");
  $("#btnMic").onclick = dictate;

  $$("#attachSheet [data-act]").forEach(
    (b) =>
      (b.onclick = () => {
        closeOverlays();
        const a = b.dataset.act;
        if (a === "camera") showView("camera");
        if (a === "photos") pick("#inPhotos", (files) => addAttachments(files));
        if (a === "files") pick("#inFiles", (files) => addAttachments(files));
        if (a === "imagine") openSheet("imagineSheet");
        if (a === "research") showView("research");
        if (a === "talk") showView("talk");
      })
  );
}

function pick(sel, cb) {
  const inp = $(sel);
  inp.value = "";
  inp.onchange = () => {
    const files = [...inp.files];
    if (files.length) cb(files);
  };
  inp.click();
}

async function processFile(file) {
  const item = { id: store.uid(), name: file.name || "file", size: file.size, status: "loading", kind: "file" };
  if (file.size > 20 * 1024 * 1024) {
    item.status = "error";
    item.error = "Too large (max 20 MB)";
    return item;
  }
  try {
    if (media.isImage(file)) {
      item.kind = "image";
      item.dataUrl = await media.compressImage(file);
      item.thumb = await media.thumb(item.dataUrl).catch(() => item.dataUrl);
    } else if (media.isPlainText(file)) {
      item.text = (await media.readText(file)).slice(0, 200000);
    } else {
      const r = await api.extract(file);
      item.text = r.text || "";
      if (!item.text.trim()) throw new Error("No readable text found");
    }
    item.status = "ready";
  } catch (e) {
    item.status = "error";
    item.error = friendlyErr(e);
  }
  return item;
}

async function addAttachments(files) {
  const placeholders = files.map((f) => ({ id: store.uid(), name: f.name, status: "loading", kind: media.isImage(f) ? "image" : "file" }));
  state.pending.push(...placeholders);
  renderPending();
  await Promise.all(
    files.map(async (f, i) => {
      const item = await processFile(f);
      const idx = state.pending.findIndex((p) => p.id === placeholders[i].id);
      if (idx < 0) return; // removed meanwhile
      if (item.status === "error") {
        toast(`${item.name}: ${item.error}`, 4000);
        state.pending.splice(idx, 1);
      } else {
        state.pending[idx] = item;
      }
      renderPending();
    })
  );
}

function renderPending() {
  const row = $("#attachRow");
  row.hidden = !state.pending.length;
  row.innerHTML = state.pending
    .map(
      (p) => `<div class="att ${p.status === "loading" ? "loading" : ""}" data-id="${p.id}">
        ${p.kind === "image" && p.thumb ? `<img src="${escapeHtml(p.thumb)}" alt="" />` : `<div class="att-name">${media.fileIcon(p.name)}<br>${escapeHtml(p.name)}</div>`}
        <button class="x" data-rm="${p.id}" aria-label="Remove">✕</button></div>`
    )
    .join("");
  $$("[data-rm]", row).forEach(
    (b) => (b.onclick = () => {
      state.pending = state.pending.filter((p) => p.id !== b.dataset.rm);
      renderPending();
    })
  );
}

async function sendFromComposer(preset) {
  const input = $("#input");
  const text = preset ?? input.value;
  if (state.pending.some((p) => p.status === "loading")) return toast("Still reading your files… one sec");
  const ready = state.pending.filter((p) => p.status === "ready");
  if (!text.trim() && !ready.length) return;
  const images = ready.filter((p) => p.kind === "image").map((p) => p.dataUrl);
  const files = ready.filter((p) => p.kind !== "image").map((p) => ({ name: p.name, size: p.size, text: p.text }));
  input.value = "";
  input.style.height = "auto";
  state.pending = [];
  renderPending();
  if (state.view !== "chat") showView("chat");
  let q = text.trim();
  if (!q && images.length) q = "What's in this photo?";
  if (!q && files.length) q = "Summarise this file for me.";
  await sendMessage(q, { images, files });
}

/* ---------- Dictation (mic in chat composer) ---------- */
const dictRec = new Recorder({});
async function dictate() {
  const btn = $("#btnMic");
  if (dictRec.active) {
    dictRec.stop();
    return;
  }
  unlockAudio();
  try {
    btn.classList.add("recording");
    toast("Listening… tap the mic again when done", 2000);
    const rec = await dictRec.start({ vad: true, silenceMs: 2200, noSpeechMs: 10000 });
    btn.classList.remove("recording");
    if (!rec) return toast("I didn't hear anything");
    setStatus("Transcribing…", "busy");
    const { text } = await api.transcribe(rec.blob, rec.filename);
    setBusy(state.busy);
    if (!text) return toast("Couldn't understand, try again");
    const input = $("#input");
    input.value = (input.value ? input.value + " " : "") + text;
    input.dispatchEvent(new Event("input"));
    input.focus();
  } catch (e) {
    btn.classList.remove("recording");
    setBusy(state.busy);
    toast(micError(e), 4000);
  }
}

function micError(e) {
  if (e?.name === "NotAllowedError") return "Microphone permission blocked. Allow it in your browser settings.";
  if (!window.isSecureContext) return "Microphone needs https — it will work once deployed.";
  return friendlyErr(e);
}

/* ================================================================== */
/* Imagine                                                             */
/* ================================================================== */
function initImagine() {
  $("#imagineGo").onclick = async () => {
    const prompt = $("#imaginePrompt").value.trim();
    if (!prompt) return toast("Describe your image first");
    closeOverlays();
    $("#imaginePrompt").value = "";
    showView("chat");
    const chat = ensureChat();
    if (chat.title === "New chat") chat.title = "🎨 " + prompt.slice(0, 44);
    if (!chat.messages.length) messagesEl().innerHTML = "";
    const u = { id: store.uid(), role: "user", content: "🎨 Create: " + prompt, ts: Date.now() };
    const b = { id: store.uid(), role: "assistant", content: "", gen: true, ts: Date.now() };
    chat.messages.push(u, b);
    messagesEl().appendChild(messageEl(u));
    const el = messageEl(b);
    messagesEl().appendChild(el);
    fillBubble($(".bubble", el), b, true);
    scrollToBottom(true);
    setStatus("Creating image…", "busy");
    try {
      const r = await api.imagine(prompt);
      b.images = [await media.compressImage(r.image, 1024, 0.88).catch(() => r.image)];
      b.content = `Here's your image ✨ — _"${prompt}"_`;
    } catch (e) {
      b.error = friendlyErr(e);
    }
    setBusy(false);
    chat.updated = Date.now();
    fillBubble($(".bubble", el), b, false);
    scrollToBottom(true);
    store.persistChats();
  };
}

/* ================================================================== */
/* Talk mode (voice conversation)                                      */
/* ================================================================== */
const talk = { on: false, greeting: false };
const talkRec = new Recorder({
  onLevel: (l) => $("#talkOrb").style.setProperty("--level", l.toFixed(3)),
  onSpeech: () => ($("#talkState").textContent = "Listening… (tap my face when you're done)"),
});

function setOrb(s) {
  $("#talkOrb").dataset.state = s;
}

function setTalkState(s, label) {
  setOrb(s);
  const labels = {
    idle: "Tap the mic and talk to me",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking… (tap my face to interrupt)",
  };
  $("#talkState").textContent = label || labels[s] || "";
  $("#talkMic").classList.toggle("active", talk.on);
}

async function startTalk() {
  if (talk.on) return;
  unlockAudio();
  speaker.stop();
  talk.on = true;
  talk.greeting = false;
  setTalkState("listening");
  vibrate(20);

  while (talk.on) {
    setTalkState("listening");
    let rec;
    try {
      rec = await talkRec.start({ vad: true, silenceMs: 1200, noSpeechMs: 10000 });
    } catch (e) {
      toast(micError(e), 4500);
      break;
    }
    if (!talk.on) break;
    if (!rec) {
      setTalkState("idle", "I didn't hear anything — tap the mic to try again");
      break;
    }

    setTalkState("thinking", "Got it, thinking…");
    let text = "";
    try {
      text = (await api.transcribe(rec.blob, rec.filename)).text || "";
    } catch (e) {
      toast(friendlyErr(e), 4000);
      break;
    }
    if (!talk.on) break;
    if (!text.trim()) {
      $("#talkState").textContent = "Sorry, I missed that. Say it again?";
      continue;
    }

    $("#capUser").textContent = text;
    $("#capBot").textContent = "";
    const ss = new SentenceStream((c) => { if (!settings.muted) speaker.enqueue(c); });
    const reply = await sendMessage(text, {
      voice: true,
      onToken: (t, full) => {
        $("#capBot").textContent = full;
        ss.push(t);
        const cap = $(".talk-captions");
        cap.scrollTop = cap.scrollHeight;
      },
    });
    ss.end();
    if (!talk.on) break;
    if (!reply) { setTalkState("idle", "Something went wrong — tap the mic to retry"); break; }
    if (!settings.muted) {
      setTalkState("speaking");
      await speaker.whenIdle();
    }
    if (!talk.on) break;
    if (!$("#handsFree").checked) break;
  }
  talk.on = false;
  if ($("#talkOrb").dataset.state !== "idle") setTalkState("idle");
  $("#talkMic").classList.remove("active");
}

function stopTalk() {
  talk.on = false;
  talk.greeting = false;
  talkRec.cancel();
  speaker.stop();
  if (state.busy) stopGenerating();
  releaseMic();
  setTalkState("idle");
}

function initTalk() {
  $("#talkMic").onclick = () => (talk.on ? stopTalk() : startTalk());
  // Tap the avatar: send now while listening / interrupt while speaking / start when idle
  $("#talkOrb").onclick = () => {
    const s = $("#talkOrb").dataset.state;
    if (s === "listening" && talkRec.active) talkRec.stop();
    else if (s === "speaking") {
      speaker.stop();
      if (talk.greeting) { talk.greeting = false; startTalk(); }
    } else if (s === "idle") startTalk();
  };
  const mute = $("#talkMute");
  mute.classList.toggle("muted", settings.muted);
  mute.onclick = () => {
    saveSettings({ muted: !settings.muted });
    mute.classList.toggle("muted", settings.muted);
    if (settings.muted) speaker.stop();
    toast(settings.muted ? "Voice muted — captions only" : "Voice on");
  };
  $("#talkToChat").onclick = () => showView("chat");
  const hf = $("#handsFree");
  hf.checked = settings.handsFree;
  hf.onchange = () => saveSettings({ handsFree: hf.checked });
}

/* ================================================================== */
/* Camera                                                              */
/* ================================================================== */
const cam = new Camera($("#camVideo"));
let camShot = null;

async function startCamera() {
  resetCameraShot();
  const msg = $("#camMsg");
  msg.hidden = true;
  if (!cam.supported) {
    msg.hidden = false;
    msg.textContent = "Live camera isn't supported here. Use the gallery button or the Files tab.";
    return;
  }
  try {
    await cam.start();
  } catch (e) {
    msg.hidden = false;
    msg.textContent = cameraErrorMessage(e);
  }
}

function resetCameraShot() {
  camShot = null;
  $("#camShot").hidden = true;
  $("#camVideo").hidden = false;
  $("#camAsk").hidden = true;
  $("#camSend").hidden = true;
  $("#camRetake").hidden = true;
  $("#camSpacer").hidden = false;
  $("#camShutter").hidden = false;
}

function showCameraShot(dataUrl) {
  camShot = dataUrl;
  const img = $("#camShot");
  img.src = dataUrl;
  img.hidden = false;
  $("#camMsg").hidden = true;
  $("#camAsk").hidden = false;
  $("#camSend").hidden = false;
  $("#camRetake").hidden = false;
  $("#camSpacer").hidden = true;
  $("#camShutter").hidden = true;
  const active = $("#camModes .chip.active");
  $("#camPrompt").value = active?.dataset.prompt || "";
}

function initCamera() {
  $("#camFlip").onclick = async () => {
    try { await cam.flip(); resetCameraShot(); } catch (e) { toast(cameraErrorMessage(e)); }
  };
  $("#camShutter").onclick = () => {
    try {
      const shot = cam.capture($("#camCanvas"));
      vibrate(30);
      const f = document.createElement("div");
      f.className = "flash";
      $(".camera").appendChild(f);
      setTimeout(() => f.remove(), 400);
      cam.stop();
      $("#camVideo").hidden = true;
      showCameraShot(shot);
    } catch (e) {
      toast(e.message);
    }
  };
  $("#camRetake").onclick = () => startCamera();
  $("#camGallery").onclick = () =>
    pick("#inPhotos", async (files) => {
      const f = files[0];
      if (!f) return;
      cam.stop();
      $("#camVideo").hidden = true;
      showCameraShot(await media.compressImage(f));
    });
  $$("#camModes .chip").forEach(
    (c) =>
      (c.onclick = () => {
        $$("#camModes .chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        if (camShot) $("#camPrompt").value = c.dataset.prompt;
      })
  );
  const send = () => {
    if (!camShot) return;
    const q = $("#camPrompt").value.trim() || "What is this?";
    const img = camShot;
    resetCameraShot();
    showView("chat");
    sendMessage(q, { images: [img] });
  };
  $("#camSend").onclick = send;
  $("#camPrompt").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
}

/* ================================================================== */
/* Files & Photos library                                              */
/* ================================================================== */
async function addToLibrary(files) {
  for (const f of files) {
    const ph = { id: store.uid(), name: f.name, size: f.size, status: "loading", kind: media.isImage(f) ? "image" : "file", selected: true };
    state.library.unshift(ph);
    renderLibrary();
    processFile(f).then((item) => {
      Object.assign(ph, item, { id: ph.id, selected: item.status === "ready" });
      if (item.status === "error") toast(`${item.name}: ${item.error}`, 4000);
      renderLibrary();
    });
  }
}

function renderLibrary() {
  const lib = $("#library");
  const items = state.library;
  $("#libEmpty").hidden = items.length > 0;
  $("#libClear").hidden = !items.length;
  $$(".lib-item", lib).forEach((n) => n.remove());
  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "lib-item" + (it.selected ? " selected" : "");
    const status =
      it.status === "loading" ? "Reading…" : it.status === "error" ? `⚠️ ${escapeHtml(it.error)}` :
      `${media.formatBytes(it.size)}${it.text ? ` · ${Math.round(it.text.length / 1000)}k chars` : ""}`;
    row.innerHTML = `
      <div class="lib-thumb">${it.kind === "image" && it.thumb ? `<img src="${escapeHtml(it.thumb)}" alt="" />` : media.fileIcon(it.name)}</div>
      <div class="lib-meta"><strong>${escapeHtml(it.name)}</strong><small>${status}</small></div>
      <button class="lib-del" aria-label="Remove">✕</button>
      <span class="lib-check"></span>`;
    row.onclick = (e) => {
      if (e.target.closest(".lib-del")) {
        state.library = state.library.filter((x) => x !== it);
        return renderLibrary();
      }
      if (it.status !== "ready") return;
      it.selected = !it.selected;
      renderLibrary();
    };
    lib.appendChild(row);
  });
  $("#libAsk").hidden = !items.some((i) => i.selected && i.status === "ready");
}

function initFiles() {
  $("#pickPhotos").onclick = () => pick("#inPhotos", addToLibrary);
  $("#pickFiles").onclick = () => pick("#inFiles", addToLibrary);
  $("#pickCameraFile").onclick = () => pick("#inCamera", addToLibrary);
  $("#pickImagine").onclick = () => openSheet("imagineSheet");
  $("#libClear").onclick = () => { state.library = []; renderLibrary(); };
  $$("#libAsk [data-q]").forEach((c) => (c.onclick = () => { $("#libPrompt").value = c.dataset.q; }));
  $("#libSend").onclick = () => {
    const sel = state.library.filter((i) => i.selected && i.status === "ready");
    if (!sel.length) return toast("Select at least one item");
    const q = $("#libPrompt").value.trim() || "Summarise this for me with the key points.";
    const images = sel.filter((i) => i.kind === "image").map((i) => i.dataUrl);
    const files = sel.filter((i) => i.kind !== "image").map((i) => ({ name: i.name, size: i.size, text: i.text }));
    $("#libPrompt").value = "";
    showView("chat");
    sendMessage(q, { images, files });
  };
}

/* ================================================================== */
/* Research                                                            */
/* ================================================================== */
function initResearch() {
  $$(".seg-btn").forEach(
    (b) =>
      (b.onclick = () => {
        $$(".seg-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        state.researchDepth = b.dataset.depth;
      })
  );
  $$(".idea").forEach((b) => (b.onclick = () => { $("#researchInput").value = b.textContent; runResearch(); }));
  $("#researchForm").addEventListener("submit", (e) => { e.preventDefault(); runResearch(); });
  $("#rCopy").onclick = () => state.research && copyText(researchAsMarkdown(state.research));
  $("#rListen").onclick = () => { if (state.research) { speaker.stop(); speakAll(state.research.report); } };
  $("#rChat").onclick = () => {
    const r = state.research;
    if (!r) return;
    startNewChat();
    const chat = ensureChat();
    chat.title = "🔎 " + r.query.slice(0, 44);
    chat.messages.push(
      { id: store.uid(), role: "user", content: `Research: ${r.query}`, ts: Date.now() },
      { id: store.uid(), role: "assistant", content: researchAsMarkdown(r), ts: Date.now() }
    );
    chat.updated = Date.now();
    store.persistChats();
    renderChat();
    $("#input").focus();
  };

  const last = store.getLastResearch();
  if (last?.report) {
    state.research = last;
    $("#researchInput").value = last.query;
    showResearch(last, true);
  }
}

function researchAsMarkdown(r) {
  const src = (r.sources || []).map((s) => `${s.n}. [${s.title}](${s.url})`).join("\n");
  return `${r.report}\n\n---\n**Sources**\n${src}`;
}

function renderSources(sources) {
  $("#researchSources").innerHTML = sources
    .map((s) => {
      let host = "";
      try { host = new URL(s.url).hostname.replace(/^www\./, ""); } catch {}
      return `<a class="source" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">
        <span class="s-top"><img src="https://icons.duckduckgo.com/ip3/${escapeHtml(host)}.ico" alt="" onerror="this.style.display='none'" />${escapeHtml(host)}<span class="s-n">${s.n}</span></span>
        <strong>${escapeHtml(s.title || host)}</strong></a>`;
    })
    .join("");
}

function showResearch(r, finished) {
  $("#researchOut").hidden = false;
  $("#researchIdeas").hidden = true;
  renderSources(r.sources || []);
  $("#researchReport").innerHTML = renderMarkdown(r.report, { sources: r.sources });
  $("#researchActions").hidden = !finished;
  if (finished) $("#researchSteps").innerHTML = "";
}

let researchController = null;
async function runResearch() {
  const query = $("#researchInput").value.trim();
  if (!query) return toast("Type what you want researched");
  researchController?.abort();
  const controller = new AbortController();
  researchController = controller;
  $("#researchInput").blur();

  const r = { query, depth: state.researchDepth, sources: [], report: "" };
  state.research = r;
  $("#researchOut").hidden = false;
  $("#researchIdeas").hidden = true;
  $("#researchActions").hidden = true;
  $("#researchSources").innerHTML = "";
  $("#researchReport").innerHTML = "";
  const steps = $("#researchSteps");
  steps.innerHTML = "";
  const go = $("#researchGo");
  go.disabled = true;
  go.textContent = "Researching…";
  setStatus("Researching…", "busy");

  const doneAll = () => $$("li", steps).forEach((li) => li.classList.add("done"));
  let raf = 0;
  try {
    await api.stream(
      "/api/research",
      { query, depth: state.researchDepth },
      (ev) => {
        if (ev.type === "status") {
          doneAll();
          const li = document.createElement("li");
          li.textContent = ev.text;
          steps.appendChild(li);
        } else if (ev.type === "queries") {
          const q = document.createElement("div");
          q.className = "q";
          q.innerHTML = ev.queries.map((x) => `<span>${escapeHtml(x)}</span>`).join("");
          steps.appendChild(q);
        } else if (ev.type === "sources") {
          r.sources = ev.sources;
          renderSources(r.sources);
        } else if (ev.type === "token") {
          r.report += ev.text;
          if (!raf)
            raf = requestAnimationFrame(() => {
              raf = 0;
              $("#researchReport").innerHTML = renderMarkdown(r.report, { sources: r.sources });
            });
        } else if (ev.type === "error") {
          r.report += `\n\n⚠️ ${ev.error}`;
        }
      },
      controller.signal
    );
    doneAll();
    if (raf) cancelAnimationFrame(raf);
    showResearch(r, true);
    store.saveLastResearch(r);
  } catch (e) {
    if (e.name !== "AbortError") {
      $("#researchReport").innerHTML = `<p class="err">⚠️ ${escapeHtml(friendlyErr(e))}</p>`;
    }
  } finally {
    go.disabled = false;
    go.textContent = "Research";
    setBusy(state.busy);
  }
}

/* ================================================================== */
/* Sheets, drawer, settings                                            */
/* ================================================================== */
function openSheet(id) {
  closeOverlays();
  $("#scrim").hidden = false;
  $("#" + id).hidden = false;
  if (id === "imagineSheet") setTimeout(() => $("#imaginePrompt").focus(), 250);
}
function closeOverlays() {
  $("#scrim").hidden = true;
  $$(".sheet, .drawer").forEach((s) => (s.hidden = true));
}

function openSettings(focusCode = false) {
  $("#setName").value = settings.name;
  $("#setEngine").value = settings.engine;
  $("#setSpeaker").value = settings.speaker;
  $("#setLang").value = settings.lang;
  $("#setAutoSpeak").checked = settings.autoSpeak;
  $("#setGreet").checked = settings.greet;
  $("#setCode").value = settings.code;
  $("#setSpeakerWrap").hidden = settings.engine !== "cloud";
  $("#setAvatarImg").src = store.getAvatar();
  openSheet("settingsSheet");
  if (focusCode) setTimeout(() => $("#setCode").focus(), 300);
}

function populateSpeakers(list) {
  const male = ["apollo", "arcas", "aries", "atlas", "draco", "hermes", "hyperion", "janus", "jupiter", "mars", "neptune", "odysseus", "orion", "orpheus", "pluto", "saturn", "zeus"];
  const all = list?.length ? list : male;
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  $("#setSpeaker").innerHTML = all
    .map((s) => `<option value="${s}">${cap(s)}${male.includes(s) ? " (male)" : " (female)"}${s === "apollo" ? " — default" : ""}</option>`)
    .join("");
  $("#setSpeaker").value = settings.speaker;
}

function initSettings() {
  $("#btnSettings").onclick = () => openSettings();
  $("#setName").onchange = (e) => saveSettings({ name: e.target.value.trim() });
  $("#setEngine").onchange = (e) => {
    saveSettings({ engine: e.target.value });
    $("#setSpeakerWrap").hidden = settings.engine !== "cloud";
  };
  $("#setSpeaker").onchange = (e) => saveSettings({ speaker: e.target.value });
  $("#setLang").onchange = (e) => saveSettings({ lang: e.target.value });
  $("#setAutoSpeak").onchange = (e) => saveSettings({ autoSpeak: e.target.checked });
  $("#setGreet").onchange = (e) => saveSettings({ greet: e.target.checked });
  $("#setCode").onchange = (e) => { saveSettings({ code: e.target.value.trim() }); toast("Access code saved"); };
  $("#setTestVoice").onclick = () => {
    unlockAudio();
    speaker.stop();
    speaker.enqueue(`Hey${settings.name ? " " + settings.name : ""}! This is how I sound. Pretty legendary, right?`);
  };
  $("#setAvatarChange").onclick = () =>
    pick("#inAvatar", async (files) => {
      try {
        const url = await media.compressImage(files[0], 512, 0.86);
        if (!store.setAvatar(url)) throw new Error("Not enough storage");
        applyAvatar();
        toast("New photo set ✓");
      } catch (e) {
        toast("Couldn't use that photo: " + e.message);
      }
    });
  $("#setAvatarReset").onclick = () => { store.setAvatar(null); applyAvatar(); toast("Photo reset"); };
  $("#setClear").onclick = () => {
    if (!confirm("Delete ALL chats? This can't be undone.")) return;
    store.clearChats();
    state.chat = null;
    renderChat();
    closeOverlays();
    toast("All chats deleted");
  };

  $("#btnHistory").onclick = () => {
    renderChatList();
    closeOverlays();
    $("#scrim").hidden = false;
    $("#drawer").hidden = false;
  };
  $("#drawerNew").onclick = () => { closeOverlays(); startNewChat(); };
  $("#btnNewChat").onclick = startNewChat;
  $("#scrim").onclick = closeOverlays;

  // swipe down to close sheets
  $$(".sheet").forEach((sheet) => {
    let y0 = null;
    sheet.addEventListener("touchstart", (e) => { if (sheet.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener("touchend", (e) => {
      if (y0 !== null && e.changedTouches[0].clientY - y0 > 90) closeOverlays();
      y0 = null;
    });
  });
}

/* ================================================================== */
/* Mobile viewport / keyboard handling                                 */
/* ================================================================== */
function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const app = $("#app");
  const onResize = () => {
    const kb = window.innerHeight - vv.height > 150;
    document.body.classList.toggle("kb-open", kb);
    app.style.height = vv.height + "px";
    app.style.bottom = "auto";
    if (kb) window.scrollTo(0, 0);
    if (kb && state.view === "chat") scrollToBottom(true);
  };
  vv.addEventListener("resize", onResize);
  onResize();
}

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */
async function checkServer() {
  try {
    const h = await api.health();
    state.server = h;
    populateSpeakers(h.speakers);
    if (!settings.speaker && h.speakers?.length) saveSettings({ speaker: "apollo" });
    setBusy(state.busy);
    const info = [`AI: ${h.models?.chat?.split("/").pop() || "Workers AI"}`, `Search: ${h.webSearch}`];
    if (h.mock) info.unshift("⚠️ Demo mode (no AI binding)");
    $("#setInfo").textContent = info.join(" · ");
    $("#setCodeWrap").hidden = !h.accessCodeRequired;
    if (h.accessCodeRequired && !settings.code) setTimeout(() => toast("Enter your access code in Settings ⚙️", 4000), 1200);
  } catch {
    setStatus("Offline", "offline");
    populateSpeakers();
  }
}

function boot() {
  applyAvatar();
  initSplash();
  initTabs();
  initComposer();
  initImagine();
  initTalk();
  initCamera();
  initFiles();
  initResearch();
  initSettings();
  initViewport();

  const recent = store.listChats()[0];
  if (recent && Date.now() - recent.updated < 1000 * 60 * 60 * 6) state.chat = recent;
  renderChat();
  renderLibrary();
  checkServer();

  window.addEventListener("online", checkServer);
  window.addEventListener("offline", () => setStatus("Offline", "offline"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.view === "camera") cam.stop();
      if (talk.on) stopTalk();
    } else if (state.view === "camera" && !camShot) startCamera();
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

boot();
