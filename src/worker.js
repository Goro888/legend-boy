/**
 * Legend Boy — AI assistant backend (Cloudflare Worker)
 *
 * Everything runs on Cloudflare:
 *   - Workers AI  → chat + vision, speech-to-text, text-to-speech, image generation, document reading
 *   - Static Assets → the mobile web app in /public
 *
 * Routes
 *   GET  /api/health       status + feature flags
 *   POST /api/chat         streamed chat (text + photos + files)          → SSE
 *   POST /api/research     web research with sources + streamed report    → SSE
 *   POST /api/transcribe   voice → text (multipart "audio")               → JSON
 *   POST /api/tts          text → voice (JSON {text, speaker})            → audio/mpeg
 *   POST /api/extract      document → text (multipart "file")             → JSON
 *   POST /api/imagine      text → image (JSON {prompt})                   → JSON
 */

const DEFAULT_MODELS = {
  chat: "@cf/meta/llama-4-scout-17b-16e-instruct", // multimodal: text + images
  stt: "@cf/openai/whisper-large-v3-turbo",
  tts: "@cf/deepgram/aura-2-en",
  image: "@cf/black-forest-labs/flux-1-schnell",
};

const TTS_SPEAKERS = [
  "apollo", "arcas", "aries", "atlas", "draco", "hermes", "hyperion", "janus", "jupiter",
  "mars", "neptune", "odysseus", "orion", "orpheus", "pluto", "saturn", "zeus",
  "amalthea", "andromeda", "asteria", "athena", "aurora", "callista", "cora", "cordelia",
  "delia", "electra", "harmonia", "helena", "hera", "iris", "juno", "luna", "minerva",
  "ophelia", "pandora", "phoebe", "thalia", "theia", "vesta",
];

const MAX_HISTORY = 24;
const MAX_FILE_CHARS = 24000;
const MAX_MSG_CHARS = 16000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      // Everything else is the web app (served by static assets).
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      if (url.pathname === "/api/health") return health(env);

      if (!checkAccess(request, env)) {
        return json({ error: "Access code required", code: "ACCESS_CODE" }, 401);
      }

      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

      switch (url.pathname) {
        case "/api/chat":
          return await handleChat(request, env);
        case "/api/research":
          return await handleResearch(request, env);
        case "/api/transcribe":
          return await handleTranscribe(request, env);
        case "/api/tts":
          return await handleTTS(request, env);
        case "/api/extract":
          return await handleExtract(request, env);
        case "/api/imagine":
          return await handleImagine(request, env);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      console.error(err);
      return json({ error: friendlyError(err) }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function models(env) {
  return {
    chat: env.CHAT_MODEL || DEFAULT_MODELS.chat,
    stt: env.STT_MODEL || DEFAULT_MODELS.stt,
    tts: env.TTS_MODEL || DEFAULT_MODELS.tts,
    image: env.IMAGE_MODEL || DEFAULT_MODELS.image,
  };
}

function isMock(env) {
  return env.MOCK_AI === "1" || env.MOCK_AI === "true" || !env.AI;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-access-code",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function checkAccess(request, env) {
  const required = (env.ACCESS_CODE || "").trim();
  if (!required) return true;
  const given = (request.headers.get("x-access-code") || "").trim();
  if (given.length !== required.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ required.charCodeAt(i);
  return diff === 0;
}

function friendlyError(err) {
  const msg = String(err?.message || err || "Unknown error");
  if (/5016|agree/i.test(msg)) return "This model requires accepting its license. " + msg;
  if (/3036|neurons|quota|limit/i.test(msg)) return "Daily AI limit reached on your Cloudflare account. Try again later. (" + msg + ")";
  return msg;
}

function health(env) {
  return json({
    ok: true,
    name: "Legend Boy",
    mock: isMock(env),
    accessCodeRequired: Boolean((env.ACCESS_CODE || "").trim()),
    webSearch: env.TAVILY_API_KEY ? "tavily" : env.BRAVE_API_KEY ? "brave" : "free",
    models: models(env),
    speakers: TTS_SPEAKERS,
  });
}

function todayString() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

function systemPrompt(env, userName) {
  const name = (userName || "").toString().slice(0, 40).trim();
  return [
    `You are Legend Boy — a friendly, confident, and genuinely helpful personal AI assistant living in the user's phone.`,
    `Personality: warm, upbeat, a little playful, never cringe. You speak like a smart friend. Keep answers clear and well organised.`,
    `Today is ${todayString()}.`,
    name ? `The user's name is ${name}. Use it naturally now and then, not in every message.` : ``,
    `Abilities inside this app: chatting, seeing photos from the camera or gallery, reading files (PDF, Word, Excel, text, code), deep web research with sources, creating images, and voice conversation.`,
    `When the user shares an image, look closely and describe or analyse exactly what is asked. When the user shares a file, its content is included between markers — use it to answer.`,
    `Format with Markdown (short paragraphs, bullet lists, **bold** for key points, code blocks for code). For casual chat keep it short.`,
    `If you are not sure about something or it may have changed recently, say so and suggest using the Research tab.`,
    `Reply in the same language the user writes in.`,
  ].filter(Boolean).join("\n");
}

function voiceAddon() {
  return `\nThe user is TALKING to you by voice and will HEAR your reply. Answer conversationally in 1–4 short sentences, no Markdown, no lists, no emojis, no URLs. Ask a quick follow-up question when natural.`;
}

/** Convert the client conversation into Workers AI chat messages. */
function buildMessages(clientMessages, env, { userName, voice }) {
  const msgs = Array.isArray(clientMessages) ? clientMessages.slice(-MAX_HISTORY) : [];

  // Only the most recent message that carries images keeps them (keeps requests small + fast).
  let lastImageIdx = -1;
  msgs.forEach((m, i) => {
    if (m && m.role === "user" && Array.isArray(m.images) && m.images.length) lastImageIdx = i;
  });

  const out = [{ role: "system", content: systemPrompt(env, userName) + (voice ? voiceAddon() : "") }];

  msgs.forEach((m, i) => {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return;
    let text = String(m.content || "").slice(0, MAX_MSG_CHARS);

    if (Array.isArray(m.files) && m.files.length) {
      const blocks = m.files
        .filter((f) => f && f.text)
        .map((f) => `\n\n<<<FILE: ${String(f.name || "file").slice(0, 120)}>>>\n${String(f.text).slice(0, MAX_FILE_CHARS)}\n<<<END FILE>>>`);
      text += blocks.join("");
    }

    const images = Array.isArray(m.images) ? m.images.filter((s) => typeof s === "string" && s.startsWith("data:image/")) : [];

    if (m.role === "user" && i === lastImageIdx && images.length) {
      const content = [{ type: "text", text: text || "What do you see in this image?" }];
      images.slice(0, 4).forEach((url) => content.push({ type: "image_url", image_url: { url } }));
      out.push({ role: "user", content });
    } else {
      if (m.role === "user" && images.length) text = `[shared ${images.length} photo(s) earlier] ` + text;
      if (!text.trim()) text = m.role === "user" ? "(empty)" : "…";
      out.push({ role: m.role, content: text });
    }
  });

  // Models expect the conversation to end with a user turn.
  if (out[out.length - 1].role !== "user") out.push({ role: "user", content: "Continue." });
  return out;
}

/** Create an SSE response and give the caller a `send(obj)` function. */
function sseStream(run) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const send = async (obj) => {
    if (closed) return;
    try {
      await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
    } catch {
      closed = true;
    }
  };
  (async () => {
    try {
      await run(send);
    } catch (err) {
      console.error(err);
      await send({ type: "error", error: friendlyError(err) });
    } finally {
      await send({ type: "done" });
      closed = true;
      try { await writer.close(); } catch {}
    }
  })();
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/** Read Workers AI SSE stream and yield text deltas (handles both native and OpenAI formats). */
async function* aiTextStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const t = j.response ?? j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.text ?? "";
        if (typeof t === "string" && t) yield t;
      } catch {
        /* ignore partial / non-JSON lines */
      }
    }
  }
}

async function runChatStream(env, messages, send, { maxTokens = 2048, temperature = 0.6 } = {}) {
  if (isMock(env)) {
    const last = messages[messages.length - 1];
    const lastText = typeof last.content === "string" ? last.content : last.content?.[0]?.text || "";
    const hasImage = Array.isArray(last.content);
    const reply =
      `**Mock mode** is on (no Cloudflare AI binding in local dev).\n\n` +
      (hasImage ? `I received your photo 📸 — once deployed I'll describe it for real.\n\n` : "") +
      `You said: _"${lastText.slice(0, 200)}"_\n\nDeploy with \`npx wrangler deploy\` and I'll answer for real. 🚀`;
    for (const word of reply.split(/(\s+)/)) {
      await send({ type: "token", text: word });
      await new Promise((r) => setTimeout(r, 12));
    }
    return reply;
  }

  const stream = await env.AI.run(models(env).chat, {
    messages,
    stream: true,
    max_tokens: maxTokens,
    temperature,
  });

  let full = "";
  for await (const t of aiTextStream(stream)) {
    full += t;
    await send({ type: "token", text: t });
  }
  return full;
}

async function runChatOnce(env, messages, { maxTokens = 512, temperature = 0.2 } = {}) {
  if (isMock(env)) return "";
  const res = await env.AI.run(models(env).chat, { messages, max_tokens: maxTokens, temperature });
  const r = res?.response ?? res?.choices?.[0]?.message?.content ?? "";
  return typeof r === "string" ? r : JSON.stringify(r);
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

async function handleChat(request, env) {
  const body = await request.json().catch(() => ({}));
  const messages = buildMessages(body.messages, env, { userName: body.userName, voice: Boolean(body.voice) });
  return sseStream(async (send) => {
    await runChatStream(env, messages, send, { maxTokens: body.voice ? 400 : 2048 });
  });
}

/* ------------------------------------------------------------------ */
/* Research                                                            */
/* ------------------------------------------------------------------ */

async function handleResearch(request, env) {
  const body = await request.json().catch(() => ({}));
  const query = String(body.query || "").trim().slice(0, 500);
  const deep = body.depth === "deep";
  if (!query) return json({ error: "Please enter a research topic." }, 400);

  return sseStream(async (send) => {
    // 1) Plan search queries
    await send({ type: "status", step: "plan", text: "Planning the research…" });
    let queries = [query];
    try {
      const planned = await runChatOnce(env, [
        {
          role: "system",
          content: `You create web search queries. Today is ${todayString()}. Output ONLY the queries, one per line, no numbering, no quotes, no extra text.`,
        },
        {
          role: "user",
          content: `Write ${deep ? 5 : 3} diverse, specific web search queries to thoroughly research: ${query}`,
        },
      ], { maxTokens: 200 });
      const lines = planned
        .split("\n")
        .map((l) => l.replace(/^[\s\-*\d.)"']+/, "").replace(/["']+$/, "").trim())
        .filter((l) => l.length > 2 && l.length < 200);
      queries = [query, ...lines].slice(0, deep ? 6 : 4);
    } catch (e) {
      console.warn("plan failed", e);
    }
    queries = [...new Set(queries)];
    await send({ type: "queries", queries });

    // 2) Search
    await send({ type: "status", step: "search", text: `Searching the web (${queries.length} searches)…` });
    const results = (await Promise.all(queries.map((q) => searchWeb(q, env).catch(() => [])))).flat();

    // Dedupe
    const seen = new Set();
    let sources = [];
    for (const r of results) {
      if (!r?.url) continue;
      const key = r.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(r);
    }
    sources = sources.slice(0, deep ? 10 : 7);

    // 3) Read pages (deep mode or when snippets are thin)
    const toRead = sources.filter((s) => !s.content || s.content.length < 400).slice(0, deep ? 5 : 3);
    if (toRead.length) {
      await send({ type: "status", step: "read", text: `Reading ${toRead.length} pages…` });
      await Promise.all(
        toRead.map(async (s) => {
          const text = await fetchPageText(s.url).catch(() => "");
          if (text) s.content = (s.content ? s.content + "\n" : "") + text.slice(0, deep ? 5000 : 3000);
        })
      );
    }

    await send({
      type: "sources",
      sources: sources.map((s, i) => ({ n: i + 1, title: s.title, url: s.url, snippet: (s.snippet || s.content || "").slice(0, 220) })),
    });

    // 4) Write report
    await send({ type: "status", step: "write", text: "Writing your report…" });
    const context = sources.length
      ? sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${(s.content || s.snippet || "").slice(0, deep ? 5000 : 3000)}`).join("\n\n---\n\n")
      : "(No web results were found. Answer from your own knowledge and clearly say that live sources were unavailable.)";

    const messages = [
      {
        role: "system",
        content:
          `You are Legend Boy, an expert research assistant. Today is ${todayString()}.\n` +
          `Write a ${deep ? "thorough, detailed" : "clear, concise"} research report in Markdown using the numbered sources provided.\n` +
          `Rules:\n- Start with a short **TL;DR**.\n- Use ## headings and bullet points.\n- Cite facts inline like [1] or [2][3] using the source numbers.\n` +
          `- If sources disagree or information may be outdated, say so.\n- End with "## Key takeaways".\n- Do NOT add a sources list at the end (the app shows it).\n- Reply in the same language as the research question.`,
      },
      { role: "user", content: `Research question: ${query}\n\nSources:\n\n${context}` },
    ];
    await runChatStream(env, messages, send, { maxTokens: deep ? 3000 : 1600, temperature: 0.3 });
  });
}

async function searchWeb(q, env) {
  if (env.TAVILY_API_KEY) return searchTavily(q, env.TAVILY_API_KEY);
  if (env.BRAVE_API_KEY) return searchBrave(q, env.BRAVE_API_KEY);
  // Free sources — no key needed
  const [ddg, wiki] = await Promise.all([searchDuckDuckGo(q).catch(() => []), searchWikipedia(q).catch(() => [])]);
  return [...ddg.slice(0, 5), ...wiki.slice(0, 2)];
}

async function searchTavily(q, key) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: 5, search_depth: "advanced" }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("tavily " + res.status);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, content: r.content }));
}

async function searchBrave(q, key) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?count=6&q=${encodeURIComponent(q)}`, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("brave " + res.status);
  const data = await res.json();
  return (data.web?.results || []).map((r) => {
    const snippet = stripTags([r.description, ...(r.extra_snippets || [])].join(" "));
    return { title: stripTags(r.title), url: r.url, snippet, content: snippet };
  });
}

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36 LegendBoy/1.0";

async function searchDuckDuckGo(q) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: `q=${encodeURIComponent(q)}`,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  return parseDuckDuckGo(html);
}

function parseDuckDuckGo(html) {
  const out = [];
  const anchors = [];
  const re = /<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = (m[0].match(/href="([^"]+)"/) || [])[1];
    if (href) anchors.push({ href, title: m[1], start: m.index, end: re.lastIndex });
  }
  anchors.forEach((a, i) => {
    if (out.length >= 8) return;
    let href = decodeEntities(a.href);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/(y\.js|l\/)/.test(href)) return;
    const block = html.slice(a.end, anchors[i + 1]?.start ?? a.end + 4000);
    const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|td)>/);
    out.push({ title: stripTags(a.title), url: href, snippet: stripTags(sn?.[1] || "") });
  });
  return out;
}

async function searchWikipedia(q) {
  const api =
    "https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3&prop=extracts|info" +
    "&inprop=url&exintro=1&explaintext=1&exlimit=max&origin=*&gsrsearch=" + encodeURIComponent(q);
  const res = await fetch(api, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map((p) => ({
    title: `${p.title} — Wikipedia`,
    url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
    snippet: (p.extract || "").slice(0, 300),
    content: p.extract || "",
  }));
}

async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(7000),
    cf: { cacheTtl: 600 },
  });
  if (!res.ok) return "";
  const type = res.headers.get("content-type") || "";
  if (!/text\/html|text\/plain/.test(type)) return "";
  const html = (await res.text()).slice(0, 600000);
  if (type.includes("text/plain")) return html.slice(0, 8000);
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n");
  return stripTags(body).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 8000);
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */

async function handleTranscribe(request, env) {
  const form = await request.formData();
  const audio = form.get("audio");
  const language = (form.get("language") || "").toString().trim();
  if (!audio || typeof audio === "string") return json({ error: "No audio received" }, 400);
  if (audio.size > 25 * 1024 * 1024) return json({ error: "Recording is too long" }, 413);

  if (isMock(env)) return json({ text: "Hey Legend Boy, what can you do? (mock transcription)" });

  const input = {
    audio: toBase64(await audio.arrayBuffer()),
    task: "transcribe",
    vad_filter: true,
    condition_on_previous_text: false,
  };
  if (language && language !== "auto") input.language = language;

  const res = await env.AI.run(models(env).stt, input);
  const text = (res?.text || res?.transcription_info?.text || "").trim();
  return json({ text, language: res?.transcription_info?.language || null });
}

async function handleTTS(request, env) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim().slice(0, 1900);
  if (!text) return json({ error: "No text" }, 400);
  if (isMock(env)) return new Response(null, { status: 204 }); // client falls back to device voice

  const speaker = TTS_SPEAKERS.includes(body.speaker) ? body.speaker : env.TTS_SPEAKER || "apollo";
  const out = await env.AI.run(models(env).tts, { text, speaker, encoding: "mp3" });

  const headers = { "content-type": "audio/mpeg", "cache-control": "no-store" };
  if (out instanceof ReadableStream) return new Response(out, { headers });
  if (out instanceof Response) return new Response(out.body, { headers });
  if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) return new Response(out, { headers });
  if (out?.audio) {
    const bin = Uint8Array.from(atob(out.audio), (c) => c.charCodeAt(0));
    return new Response(bin, { headers });
  }
  return json({ error: "TTS returned no audio" }, 502);
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

async function handleExtract(request, env) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "No file received" }, 400);
  if (file.size > 20 * 1024 * 1024) return json({ error: "File is too large (max 20 MB)" }, 413);

  if (isMock(env)) {
    return json({ name: file.name, text: `(Mock mode) Pretend content of ${file.name}. Deploy to read real documents.` });
  }

  const blob = new Blob([await file.arrayBuffer()], { type: file.type || guessMime(file.name) });
  let result = await env.AI.toMarkdown([{ name: file.name || "document", blob }]);
  if (Array.isArray(result)) result = result[0];
  if (!result || result.format === "error") {
    return json({ error: result?.error || "Could not read this file type." }, 422);
  }
  return json({ name: file.name, text: String(result.data || "").slice(0, 200000), tokens: result.tokens || null });
}

function guessMime(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  return (
    {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      odt: "application/vnd.oasis.opendocument.text",
      csv: "text/csv",
      html: "text/html",
      htm: "text/html",
      xml: "application/xml",
      numbers: "application/vnd.apple.numbers",
    }[ext] || "application/octet-stream"
  );
}

/* ------------------------------------------------------------------ */
/* Imagine                                                             */
/* ------------------------------------------------------------------ */

async function handleImagine(request, env) {
  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim().slice(0, 2000);
  if (!prompt) return json({ error: "Describe the image you want." }, 400);

  if (isMock(env)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#fff" font-size="36" font-family="sans-serif" text-anchor="middle">Mock image</text></svg>`;
    return json({ image: "data:image/svg+xml;base64," + btoa(svg), prompt });
  }

  const res = await env.AI.run(models(env).image, { prompt, steps: 6 });
  let b64 = res?.image;
  if (!b64 && res instanceof ReadableStream) b64 = toBase64(await new Response(res).arrayBuffer());
  if (!b64) return json({ error: "Image generation failed" }, 502);
  return json({ image: `data:image/jpeg;base64,${b64}`, prompt });
}
