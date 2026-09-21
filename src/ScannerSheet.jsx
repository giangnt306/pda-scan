import { useEffect, useRef, useState } from "react";
import { getBarcodeEngine, FORMAT_LABEL } from "./lib/barcode.js";
import { startCamera, stopCamera, torchCapable, setTorch, grabFrame, buzz } from "./lib/camera.js";

const DEDUPE_MS = 1800; // cùng một mã trong khoảng này thì bỏ qua
const DETECT_INTERVAL = 120; // ~8 lần/giây, đủ nhanh mà đỡ tốn pin

const ERROR_TEXT = {
  SecurityError:
    "Trình duyệt chặn camera vì trang không chạy trên HTTPS. Mở lại bằng địa chỉ https://, hoặc xem hướng dẫn bật cờ Chrome ở README.",
  NotAllowedError:
    "Quyền camera đang bị từ chối. Bấm biểu tượng ổ khoá trên thanh địa chỉ, chọn Quyền, rồi cho phép Camera và tải lại trang.",
  NotFoundError: "Không tìm thấy camera nào trên thiết bị này.",
  NotReadableError: "Camera đang bị ứng dụng khác chiếm. Đóng ứng dụng đó rồi thử lại.",
  NotSupportedError: "Trình duyệt này không hỗ trợ truy cập camera. Dùng Chrome trên Android.",
};

export default function ScannerSheet({ target, onBarcode, onPhoto, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const lastHitRef = useRef({ value: "", at: 0 });
  const aliveRef = useRef(true);

  const [status, setStatus] = useState("starting"); // starting | ready | error
  const [errorKey, setErrorKey] = useState(null);
  const [engineNative, setEngineNative] = useState(null);
  const [torchOn, setTorchOn] = useState(false);
  const [canTorch, setCanTorch] = useState(false);
  const [hit, setHit] = useState(null); // { value, format }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    aliveRef.current = true;
    let timer = null;

    (async () => {
      try {
        const stream = await startCamera(videoRef.current);
        if (!aliveRef.current) return stopCamera(stream);
        streamRef.current = stream;
        setCanTorch(torchCapable(stream));
        setStatus("ready");

        const { detector, native } = await getBarcodeEngine();
        if (!aliveRef.current) return;
        setEngineNative(native);

        const loop = async () => {
          if (!aliveRef.current) return;
          const video = videoRef.current;
          if (video?.readyState >= 2) {
            try {
              const codes = await detector.detect(video);
              if (codes.length > 0) handleHit(codes[0]);
            } catch {
              /* frame lỗi thì bỏ qua, vòng sau detect tiếp */
            }
          }
          if (aliveRef.current) timer = setTimeout(loop, DETECT_INTERVAL);
        };
        loop();
      } catch (err) {
        if (!aliveRef.current) return;
        setErrorKey(err?.name || "NotSupportedError");
        setStatus("error");
      }
    })();

    return () => {
      aliveRef.current = false;
      clearTimeout(timer);
      stopCamera(streamRef.current);
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleHit(code) {
    const value = (code.rawValue || "").trim();
    if (!value) return;

    const now = Date.now();
    const last = lastHitRef.current;
    if (last.value === value && now - last.at < DEDUPE_MS) return;
    lastHitRef.current = { value, at: now };

    buzz(60);
    setHit({ value, format: code.format });

    if (target) {
      onBarcode?.(target.key, value);
      setTimeout(() => aliveRef.current && onClose?.(), 350);
    }
  }

  async function toggleTorch() {
    const next = !torchOn;
    const ok = await setTorch(streamRef.current, next);
    if (ok) setTorchOn(next);
    else setCanTorch(false);
  }

  async function shoot() {
    setBusy(true);
    try {
      const frame = await grabFrame(videoRef.current);
      buzz(40);
      onPhoto?.(frame);
      onClose?.();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Camera quét mã">
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
          {target ? `Quét ${target.label.toLowerCase()}` : "Quét mã hoặc chụp nhãn"}
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
        {hit ? (
          <div className="sheet-hit">
            <span className="chip sure">{FORMAT_LABEL[hit.format] || hit.format}</span>
            <span className="mono">{hit.value}</span>
            {!target && (
              <button className="btn small" onClick={() => onBarcode?.(null, hit.value)}>
                Dùng mã này
              </button>
            )}
          </div>
        ) : (
          <div className="sheet-hint">
            {status === "ready"
              ? "Đưa mã vạch vào giữa khung"
              : "\u00a0"}
            {engineNative === false && <em> · đang dùng bộ giải mã dự phòng</em>}
          </div>
        )}

        {status === "ready" && (
          <button className="shutter" onClick={shoot} disabled={busy} aria-label="Chụp nhãn">
            <span />
            {busy ? "Đang xử lý…" : "Chụp nhãn để nhận dạng"}
          </button>
        )}
      </div>
    </div>
  );
}
