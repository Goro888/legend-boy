// Live camera: preview, flip front/back, capture a still.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = "environment";
  }

  get supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start(facing = this.facing) {
    this.stop();
    this.facing = facing;
    const tries = [
      { video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: facing }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const c of tries) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        lastErr = e;
        if (e.name === "NotAllowedError" || e.name === "SecurityError") break;
      }
    }
    if (!this.stream) throw lastErr || new Error("Camera unavailable");
    this.video.srcObject = this.stream;
    this.video.style.transform = facing === "user" ? "scaleX(-1)" : "";
    await this.video.play().catch(() => {});
  }

  async flip() {
    await this.start(this.facing === "environment" ? "user" : "environment");
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get active() {
    return Boolean(this.stream);
  }

  /** Capture current frame → JPEG data URL (max 1280px). */
  capture(canvas, max = 1280) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) throw new Error("Camera not ready yet");
    const scale = Math.min(1, max / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d");
    if (this.facing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85);
  }
}

export function cameraErrorMessage(e) {
  const n = e?.name || "";
  if (n === "NotAllowedError") return "Camera permission was blocked. Allow camera access for this site in your browser settings, then try again.";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "No camera found on this device.";
  if (n === "NotReadableError") return "The camera is being used by another app. Close it and try again.";
  if (!window.isSecureContext) return "Camera needs a secure (https) connection. It will work once deployed on Cloudflare.";
  return "Could not start the camera: " + (e?.message || n || "unknown error");
}
