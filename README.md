# Legend Boy: your AI assistant for your phone

Legend Boy is a mobile AI assistant that runs completely on **Cloudflare**. You don't need an OpenAI key, a server, or any other paid API.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Goro888/Alixo)

## Features

| Section | What it does |
|---|---|
| **Splash** | Opens with Legend Boy's photo and a glowing animation. Tap it and he **greets you out loud** |
| **Talk** | Hands-free voice chat. You talk, he listens, stops by himself when you go quiet, answers **with his voice**, then listens again. Tap his face to interrupt him |
| **Chat** | Streaming AI chat with Markdown and code blocks (with a copy button). Each reply can be copied, read aloud, shared or retried. Chats are saved to the device, and you can use voice typing |
| **Camera** | Live camera with front/back flip. Take a photo, then ask about it with a mode: *Describe, Read text, Solve, Translate, Identify, Tips* |
| **Files & Photos** | Add photos and documents: **PDF, Word, Excel, CSV, text, code**. Then summarise them, explain them, pull out key facts, or get a quiz |
| **Research** | Searches the web with several queries, reads the pages, and writes a report with **numbered citations** and source cards. Has *Quick* and *Deep* modes |
| **Create image** | Makes an image from text (FLUX) |
| **Settings** | Change Legend Boy's photo, set your name, pick his voice (40 HD voices or the phone's built-in voice), choose the speech language, turn on auto-read and the startup greeting, delete chats |
| **Install as app** | It's a PWA: "Add to Home Screen" gives it an icon and opens it full screen with no browser bar |

### AI models (all Cloudflare Workers AI)
- Chat + vision: `@cf/meta/llama-4-scout-17b-16e-instruct`
- Speech-to-text: `@cf/openai/whisper-large-v3-turbo` (many languages)
- Voice: `@cf/deepgram/aura-2-en`
- Images: `@cf/black-forest-labs/flux-1-schnell`
- Documents: Workers AI `toMarkdown()` (PDF, DOCX, XLSX, and more)

---

## 🚀 Deploy to Cloudflare

### Option A: Cloudflare dashboard (no computer needed, works from a phone)
1. Log in at **dash.cloudflare.com**, then go to **Workers & Pages → Create → Import a repository**.
2. Connect GitHub and choose **Goro888/Alixo**.
3. Build settings:
   - **Build command:** *(leave empty)*
   - **Deploy command:** `npx wrangler deploy`
4. Click **Deploy**. Your app goes live at `https://legend-boy.<your-name>.workers.dev` 🎉

### Option B: from a computer
```bash
npm install
npx wrangler login      # opens the browser once
npm run deploy          # = npx wrangler deploy
```

### Put it on your phone like a real app
Open your `workers.dev` link on the phone:
- **iPhone (Safari):** Share → **Add to Home Screen**
- **Android (Chrome):** ⋮ menu → **Install app** / **Add to Home screen**

> Camera and microphone need **https**. Cloudflare gives you https automatically.

---

## 🖼️ Use your own photo for Legend Boy
There are two ways:
1. **In the app:** Settings ⚙️ → *Legend Boy's photo* → **Change photo**. The photo is stored on your phone.
2. **For everyone:** replace `public/img/legend-boy.jpg` with your photo (square, about 640×640). If you want the icons to match, also replace `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` and `favicon.png` in the same folder. Then redeploy.

---

## 🔐 Optional settings (secrets)
Set these with `npx wrangler secret put NAME`, or in the dashboard under **Worker → Settings → Variables and Secrets**:

| Secret | Why |
|---|---|
| `ACCESS_CODE` | Locks the app with a password so strangers can't use up your AI credits. Enter the code in the app's Settings |
| `TAVILY_API_KEY` | Better web research ([tavily.com](https://tavily.com), free tier). Without it, research uses DuckDuckGo + Wikipedia |
| `BRAVE_API_KEY` | Another web search option ([brave.com/search/api](https://brave.com/search/api)) |

You can switch models with the `CHAT_MODEL`, `STT_MODEL`, `TTS_MODEL`, `IMAGE_MODEL` and `TTS_SPEAKER` vars in `wrangler.jsonc`.

**Cost:** Workers AI includes a free daily allowance (10,000 neurons/day on the free plan). That's plenty for personal use. Past that it's pay-as-you-go on the Workers Paid plan.

---

## 🧪 Local development
```bash
npm install
npm run dev:demo   # demo mode: fake AI answers, no Cloudflare login needed
npm run dev        # real Workers AI (needs `npx wrangler login`)
```

## Project structure
```
wrangler.jsonc          Cloudflare config (Worker + static assets + AI binding)
wrangler.demo.jsonc     Local demo config (fake AI)
src/worker.js           API: /api/chat, /api/research, /api/transcribe, /api/tts, /api/extract, /api/imagine
public/                 The phone app (no build step)
  index.html            Screens: splash, chat, talk, camera, files, research, settings
  css/app.css           Mobile-first dark UI with safe-area support
  js/app.js             App logic
  js/voice.js           Mic recording + auto-stop on silence + voice playback queue
  js/camera.js          Live camera
  js/markdown.js        Safe Markdown renderer
  js/api.js, store.js, media.js
  sw.js, manifest.webmanifest   Installable PWA
  img/                  Legend Boy photo + app icons
```
