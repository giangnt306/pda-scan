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
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });

  videoEl.srcObject = stream;
  videoEl.setAttribute("playsinline", "");
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

export function buzz(ms = 60) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* không có thì thôi */
  }
}

/* ================================================================
   Chụp ảnh — chỉ dùng ImageCapture.takePhoto()
================================================================ */

export const imageCaptureSupported = () => typeof window.ImageCapture === "function";

/* Độ phân giải tối đa mà cảm biến cho phép ImageCapture chụp.
 * Khác hẳn độ phân giải luồng video (thường chỉ 1920×1080). */
export async function getPhotoInfo(stream) {
  const track = stream?.getVideoTracks()[0];
  if (!track || !imageCaptureSupported()) return null;
  try {
    const caps = await new ImageCapture(track).getPhotoCapabilities();
    return {
      maxWidth: caps.imageWidth?.max ?? null,
      maxHeight: caps.imageHeight?.max ?? null,
      fillLight: caps.fillLightMode ?? [],
    };
  } catch {
    return null;
  }
}

/* Yêu cầu camera chụp một ảnh tĩnh thật sự ở độ phân giải cảm biến,
 * không phải cắt từ luồng video. */
export async function takeFullPhoto(stream) {
  const track = stream.getVideoTracks()[0];
  const ic = new ImageCapture(track);

  const settings = {};
  try {
    const caps = await ic.getPhotoCapabilities();
    if (caps.imageWidth?.max) settings.imageWidth = caps.imageWidth.max;
    if (caps.imageHeight?.max) settings.imageHeight = caps.imageHeight.max;
  } catch {
    /* không đọc được capabilities → để trình duyệt tự chọn */
  }

  let blob;
  try {
    blob = await ic.takePhoto(settings);
  } catch {
    // Một số máy từ chối cặp width/height cụ thể → thử lại không tham số
    blob = await ic.takePhoto();
  }

  const { width, height } = await measure(blob);
  return { blob, width, height };
}

async function measure(blob) {
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

/* Bản thu nhỏ để hiển thị và gửi OCR (bước 4). */
export async function downscale(blob, maxSide = 1280, quality = 0.82) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const small = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return { blob: small, url: URL.createObjectURL(small), width: w, height: h };
}

/* ================================================================
   ID ảnh
================================================================ */

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
};

/* ID ảnh: IMG-YYYYMMDD-HHMMSS-mmm, mili-giây để hai lần chụp liền nhau không trùng. */
export function photoId(d) {
  return `IMG-${stamp(d)}-${String(d.getMilliseconds()).padStart(3, "0")}`;
}
