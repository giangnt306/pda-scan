import { useEffect, useRef, useState } from "react";
import {
  startCamera,
  stopCamera,
  torchCapable,
  setTorch,
  buzz,
  imageCaptureSupported,
  getPhotoInfo,
  takeFullPhoto,
} from "./lib/camera.js";

const ERROR_TEXT = {
  SecurityError:
    "Trình duyệt chặn camera vì trang không chạy trên HTTPS. Mở lại bằng địa chỉ https://, hoặc xem hướng dẫn bật cờ Chrome ở README.",
  NotAllowedError:
    "Quyền camera đang bị từ chối. Bấm biểu tượng ổ khoá trên thanh địa chỉ, chọn Quyền, rồi cho phép Camera và tải lại trang.",
  NotFoundError: "Không tìm thấy camera nào trên thiết bị này.",
  NotReadableError: "Camera đang bị ứng dụng khác chiếm. Đóng ứng dụng đó rồi thử lại.",
  NotSupportedError: "Trình duyệt này không hỗ trợ truy cập camera. Dùng Chrome trên Android.",
};

export default function ScannerSheet({ onPhoto, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const aliveRef = useRef(true);

  const [status, setStatus] = useState("starting"); // starting | ready | error
  const [errorKey, setErrorKey] = useState(null);
  const [torchOn, setTorchOn] = useState(false);
  const [canTorch, setCanTorch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [photoInfo, setPhotoInfo] = useState(null);
  const [shotError, setShotError] = useState("");

  useEffect(() => {
    aliveRef.current = true;

    (async () => {
      try {
        const stream = await startCamera(videoRef.current);
        if (!aliveRef.current) return stopCamera(stream);
        streamRef.current = stream;
        setCanTorch(torchCapable(stream));
        getPhotoInfo(stream).then((info) => aliveRef.current && setPhotoInfo(info));
        setStatus("ready");
      } catch (err) {
        if (!aliveRef.current) return;
        setErrorKey(err?.name || "NotSupportedError");
        setStatus("error");
      }
    })();

    return () => {
      aliveRef.current = false;
      stopCamera(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  async function toggleTorch() {
    const next = !torchOn;
    const ok = await setTorch(streamRef.current, next);
    if (ok) setTorchOn(next);
    else setCanTorch(false);
  }

  async function shoot() {
    setBusy(true);
    setShotError("");

    try {
      const shot = await takeFullPhoto(streamRef.current);
      buzz(40);
      onPhoto?.(shot);
      onClose?.();
    } catch (err) {
      setShotError(err?.message || "Chụp thất bại, thử lại");
      setBusy(false);
    }
  }

  const canShoot = imageCaptureSupported();
  const modeLabel = canShoot
    ? `ImageCapture${photoInfo?.maxWidth ? ` · tối đa ${photoInfo.maxWidth}×${photoInfo.maxHeight}` : ""}`
    : "Trình duyệt không hỗ trợ ImageCapture — không chụp được nhãn";

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Camera chụp nhãn">
      <video ref={videoRef} className="sheet-video" muted playsInline />

      {status === "ready" && (
        <div className="sheet-mask" aria-hidden="true">
          <div className="sheet-window" />
        </div>
      )}

      <div className="sheet-top">
        <button className="ghost" onClick={onClose} aria-label="Đóng camera">
          Đóng
        </button>
        <div className="sheet-title">
          Chụp nhãn
          <div className="sheet-mode">{modeLabel}</div>
        </div>
        {canTorch ? (
          <button
            className={`ghost${torchOn ? " on" : ""}`}
            onClick={toggleTorch}
            aria-pressed={torchOn}
          >
            Đèn
          </button>
        ) : (
          <span className="ghost-spacer" />
        )}
      </div>

      {status === "starting" && <div className="sheet-center">Đang mở camera…</div>}

      {status === "error" && (
        <div className="sheet-center error">
          <strong>Không mở được camera</strong>
          <p>{ERROR_TEXT[errorKey] || ERROR_TEXT.NotSupportedError}</p>
          <button className="btn" onClick={onClose}>
            Quay lại nhập tay
          </button>
        </div>
      )}

      <div className="sheet-bottom">
        <div className="sheet-hint">
          {status === "ready" ? "Đưa toàn bộ nhãn vào giữa khung" : " "}
        </div>

        {shotError && <div className="sheet-shot-error">{shotError}</div>}

        {status === "ready" && canShoot && (
          <button className="shutter" onClick={shoot} disabled={busy} aria-label="Chụp nhãn">
            <span />
            {busy ? "Đang chụp… giữ yên máy" : "Chụp nhãn để nhận dạng"}
          </button>
        )}
      </div>
    </div>
  );
}
