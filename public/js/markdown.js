// Small, safe Markdown renderer (HTML is escaped first; only http(s) links allowed).

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text, opts) {
  // protect inline code
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  // bare urls
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  // citations [1] [2][3]
  if (opts.sources) {
    s = s.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
      const src = opts.sources[Number(n) - 1];
      return src ? `<sup><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${n}</a></sup>` : m;
    });
  }
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

export function renderMarkdown(src, opts = {}) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inline(l, opts)).join("<br>")}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or end while streaming)
      out.push(`<pre><button class="copy-code" type="button">Copy</button><code data-lang="${esc(fence[1] || "")}">${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${inline(h[2], opts)}</h${lvl}>`);
      i++;
      continue;
    }

    // hr
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"), opts)}</blockquote>`);
      continue;
    }

    // table
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara();
      const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c, opts)}</th>`).join("")}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table>`
      );
      continue;
    }

    // lists
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) {
          const nested = m[1].length >= 2 && items.length;
          if (nested) items[items.length - 1].sub.push(lines[i].replace(/^\s{2,4}/, ""));
          else items.push({ text: m[3], sub: [] });
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].sub.push(lines[i].trim());
          i++;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items
          .map((it) => {
            const subIsList = it.sub.length && /^([-*+]|\d+[.)])\s/.test(it.sub[0]);
            const sub = it.sub.length ? (subIsList ? renderMarkdown(it.sub.join("\n"), opts) : "<br>" + it.sub.map((s) => inline(s, opts)).join("<br>")) : "";
            return `<li>${inline(it.text, opts)}${sub}</li>`;
          })
          .join("")}</${tag}>`
      );
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join("");
}

/** Remove markdown so text sounds natural when spoken. */
export function toSpeech(md) {
  return String(md || "")
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\d{1,2}\]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/[*_~>#|]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
