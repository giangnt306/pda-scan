/* Các thao tác với camera thiết bị. */

export async function startCamera(videoEl) {
  if (!window.isSecureContext) {
    throw new DOMException("INSECURE", "SecurityError");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("UNSUPPORTED", "NotSupportedError");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // `ideal` chứ không `exact`: laptop chỉ có webcam trước vẫn chạy được
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });

  videoEl.srcObject = stream;
  videoEl.setAttribute("playsinline", ""); // iOS: không tự bung fullscreen
  await videoEl.play();
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function torchCapable(stream) {
  const track = stream?.getVideoTracks()[0];
  return Boolean(track?.getCapabilities?.().torch);
}

export async function setTorch(stream, on) {
  const track = stream?.getVideoTracks()[0];
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  } catch {
    return false;
  }
}

/* Chụp 1 frame, thu nhỏ cạnh dài về `maxSide` rồi nén JPEG.
 * Ảnh gốc 1920px ≈ 1.5MB, sau khi nén còn ~150KB — khác biệt lớn với
 * mạng WiFi trong kho. */
export async function grabFrame(videoEl, maxSide = 1280, quality = 0.82) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error("Camera chưa sẵn sàng");

  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(videoEl, 0, 0, w, h);

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return { blob, url: URL.createObjectURL(blob), width: w, height: h };
}

export function buzz(ms = 60) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* không có thì thôi */
  }
}
