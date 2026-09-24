// Image + file helpers.

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Resize + compress an image (File or data URL) to a JPEG data URL. */
export async function compressImage(input, max = 1280, quality = 0.82) {
  let src = input;
  let objectUrl = null;
  if (input instanceof Blob) {
    objectUrl = URL.createObjectURL(input);
    src = objectUrl;
  }
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", quality);
  } catch (e) {
    // HEIC or unsupported format: send original as data URL if it's small enough
    if (input instanceof Blob) return fileToDataUrl(input);
    throw e;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export const thumb = (src) => compressImage(src, 360, 0.7);

const TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cs|go|rs|php|rb|swift|kt|sql|yaml|yml|toml|ini|log|sh|bat|css|scss|vue|svelte|env|srt|vtt|tex|r|dart|lua|pl)$/i;
const DOC_EXT = /\.(pdf|docx|xlsx|xls|ods|odt|csv|html?|xml|numbers)$/i;

export function isImage(file) {
  return (file.type || "").startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(file.name || "");
}
export function isPlainText(file) {
  return (file.type || "").startsWith("text/plain") || TEXT_EXT.test(file.name || "") || file.type === "application/json";
}
export function isDocument(file) {
  return DOC_EXT.test(file.name || "");
}

export function readText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function fileIcon(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "📕";
  if (["doc", "docx", "odt"].includes(ext)) return "📘";
  if (["xls", "xlsx", "ods", "csv", "numbers"].includes(ext)) return "📗";
  if (["html", "htm", "xml", "json"].includes(ext)) return "🌐";
  if (["txt", "md", "log"].includes(ext)) return "📝";
  return "📄";
}

export function formatBytes(n = 0) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
