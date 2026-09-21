/* Chọn engine đọc mã vạch.
 *
 * Chrome trên Android có sẵn BarcodeDetector (từ Chrome 83) — chạy bằng ML
 * stack của Google Play Services, nhanh và không tốn thêm băng thông.
 * Nhưng Chrome trên Windows/Linux thì KHÔNG có, nên khi bạn test trên laptop
 * sẽ phải rơi về bản ponyfill chạy WebAssembly (nặng hơn ~500KB, chậm hơn).
 *
 * Vì vậy engine được nạp lười (lazy): máy Android không bao giờ tải WASM.
 */

const WANTED_FORMATS = [
  "qr_code",
  "code_128",
  "code_39",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "itf",
  "data_matrix",
];

let enginePromise = null;

export function getBarcodeEngine() {
  if (!enginePromise) enginePromise = createEngine();
  return enginePromise;
}

async function createEngine() {
  if ("BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
      if (formats.length > 0) {
        return { detector: new window.BarcodeDetector({ formats }), native: true };
      }
    } catch {
      /* rơi xuống ponyfill */
    }
  }

  const { BarcodeDetector } = await import("barcode-detector/ponyfill");
  const supported = await BarcodeDetector.getSupportedFormats();
  const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
  return { detector: new BarcodeDetector({ formats }), native: false };
}

/* Tên format hiển thị cho người dùng */
export const FORMAT_LABEL = {
  qr_code: "QR",
  code_128: "Code 128",
  code_39: "Code 39",
  ean_13: "EAN-13",
  ean_8: "EAN-8",
  upc_a: "UPC-A",
  upc_e: "UPC-E",
  itf: "ITF",
  data_matrix: "DataMatrix",
};
