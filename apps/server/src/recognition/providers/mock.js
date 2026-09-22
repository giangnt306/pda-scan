/* Provider giả lập. Cùng contract với provider http (xem ../service.js):
 *   recognize({ recognitionId, image, options, signal }) → { raw, fields }
 *
 * options.mode: success | slow | error | timeout
 *   success : trả kết quả sau delayMs
 *   slow    : trả kết quả sau slowDelayMs (vẫn dưới RECOGNITION_TIMEOUT_MS nếu cấu hình mặc định)
 *   error   : ném lỗi PROVIDER_ERROR như AI server trả 500
 *   timeout : không bao giờ trả, chờ đến khi signal abort → service báo RECOGNITION_TIMEOUT
 *
 * Giá trị trả về cố ý ở dạng "như in trên nhãn" (ngày viết tay, số dạng chuỗi) để
 * bộ chuẩn hoá phía service được chạy thật, giống khi nối AI server.
 */

const SAMPLE_RAW = {
  model: "mock-vlm-0",
  fields: [
    { name: "part_number", text: "BEX32181030AB", score: 0.94 },
    { name: "part_name", text: "BATTERY_PACK_REAR_FENDER", score: 0.96 },
    { name: "qty", text: "80", score: 0.91 },
    { name: "ship_date", text: "15/9/2026", score: 0.62 },
    { name: "sa_number", text: "5300013009", score: 0.89 },
    { name: "variant", text: "Limo Green", score: 0.93 },
    { name: "supplier", text: "noi bo - made in vietnam", score: 0.75 },
    { name: "gross_weight", text: "12,5", score: 0.7 },
  ],
};

/* Ánh xạ tên field của "AI" sang key của form. Với AI thật, bảng này nằm trong provider http. */
const NAME_MAP = {
  part_number: "partNumber",
  part_name: "partName",
  qty: "quantity",
  ship_date: "shipmentDate",
  sa_number: "saNumber",
  variant: "variant",
  supplier: "supplier",
  gross_weight: "grossWeight",
};

export function mapMockResponse(raw) {
  const fields = {};
  for (const f of raw.fields || []) {
    const key = NAME_MAP[f.name];
    if (!key) continue;
    fields[key] = { value: f.text, confidence: f.score };
  }
  return fields;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function createMockProvider({ delayMs = 700, slowDelayMs = 6000, mode = "success" } = {}) {
  return {
    name: "mock",
    async recognize({ image, options = {}, signal }) {
      const m = options.mode || mode;
      // timeout: treo cho tới khi service abort. Dùng timer thật (có ref) để event loop không tự thoát.
      if (m === "timeout") await sleep(2 ** 31 - 1, signal);
      await sleep(m === "slow" ? slowDelayMs : delayMs, signal);
      if (m === "error") {
        throw Object.assign(new Error("Mô phỏng: AI server trả lỗi 500"), { code: "PROVIDER_ERROR" });
      }
      // image.bytes/mimeType có sẵn; mock không đọc nội dung ảnh.
      const raw = { ...SAMPLE_RAW, imageBytes: image.bytes, mode: m };
      return { raw, fields: mapMockResponse(raw) };
    },
  };
}
