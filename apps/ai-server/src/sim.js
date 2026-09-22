/* Giả lập "dịch vụ OCR bị hỏng" ngay trong ai-server — KHÔNG gọi OpenAI, KHÔNG tốn quota.
 *
 * Vì sao cần: cả đội phải demo được mọi tình trạng OCR (chậm, lỗi 500, treo, thiếu trường,
 * đọc ra chữ rác) mà không có API key và không mất tiền. `OCR_SIM_MODE` là env của tiến trình
 * (xem QUYẾT ĐỊNH AI-1) vì nó mô phỏng tình trạng của cả dịch vụ, không phải của một request.
 *
 * Tầng mô phỏng bên Main Backend (sim/ocrWrapper.js) là chuyện khác: BE mô phỏng "OCR trả kết quả
 * kém", ai-server mô phỏng "dịch vụ OCR hỏng". Hai tầng độc lập, không chồng chéo.
 *
 * Đầu ra của recognizeSimulated() có đúng shape của recognizeWithLlm():
 *   { model, fields: [{ name, text, score }] (đủ 10, đúng thứ tự), rawText, usage, retryCount }
 */

export const OCR_SIM_MODES = ["passthrough", "slow", "error", "timeout", "partial", "garbage"];

/* Mẫu dữ liệu lấy từ nhãn thật sample/image.jpeg — cố định để test tất định. */
export const SIM_SAMPLE_FIELDS = [
  { name: "part_number", text: "BEX32181030AB", score: 0.94 },
  { name: "part_name", text: "BATTERY_PACK_REAR_FENDER", score: 0.96 },
  { name: "qty", text: "80", score: 0.91 },
  { name: "ship_date", text: "15/9/2026", score: 0.62 },
  { name: "supplier", text: "VINFAST", score: 0.75 },
  { name: "sa_number", text: "5300013009", score: 0.89 },
  { name: "variant", text: "Limo Green", score: 0.93 },
  { name: "plant_dock", text: null, score: 0 },
  { name: "batch", text: "260917_79F", score: 0.88 },
  { name: "gross_weight", text: "12,5", score: 0.7 },
];

export const SIM_SAMPLE_RAW_TEXT = "PART NO BEX32181030AB\nBATTERY_PACK_REAR_FENDER\nQTY 80\nDATE 15/9/2026";

/* Mode "partial": giữ đúng 4 trường của mẫu, 6 trường còn lại bị xoá (text=null, score=0).
 * Lưu ý: plant_dock trong mẫu vốn đã null, nên kết quả có 7 trường text=null — 6 trong số đó
 * là do mode partial xoá đi. BE sẽ thấy các trường bắt buộc part_number/ship_date/supplier "missing". */
export const PARTIAL_KEEP = ["qty", "part_name", "batch", "plant_dock"];

/* Mode "garbage": chữ rác CỐ ĐỊNH (không ngẫu nhiên — test phải tất định). */
export const GARBAGE_FIELDS_OVERRIDE = {
  part_number: "X#@!9-??",
  part_name: "▒▒▒ĐỌC KHÔNG RA▒▒▒",
  qty: "??",
  ship_date: "32/13/20XX",
};
export const GARBAGE_RAW_TEXT = "▓▒░ ?? ##@@ ▒▓ KHONG DOC DUOC ░▒▓";

export class SimOcrError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "SimOcrError";
    this.code = code;
    this.status = status ?? null;
  }
}

/* Lỗi huỷ: dùng đúng `signal.reason` nếu có (AbortSignal.timeout → DOMException "TimeoutError")
 * để server.js rẽ đúng nhánh 504. */
const abortError = (signal) => signal?.reason ?? new DOMException("Bị huỷ", "AbortError");

/* sleep huỷ được: khi signal abort thì clearTimeout ngay, không để test treo 25 s (cạm bẫy #5). */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* Treo tới khi signal abort. Timer CÓ ref (không unref) để event loop không thoát sớm
 * trong lúc đang "treo" — giống providers/mock.js bên BE (cạm bẫy #6). */
export function hangUntilAbort(signal) {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const keepAlive = setTimeout(() => {}, 2 ** 31 - 1);
    if (!signal) return; // không có signal → treo thật (chỉ xảy ra nếu gọi sai)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(keepAlive);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}

const sampleFields = () => SIM_SAMPLE_FIELDS.map((f) => ({ ...f }));

/* Trả { model, fields, rawText, usage, retryCount } giống recognizeWithLlm, hoặc ném lỗi.
 * KHÔNG gọi mạng ở bất kỳ mode nào. Tôn trọng signal cho mode slow / timeout. */
export async function recognizeSimulated({ mode, config = {}, signal }) {
  if (!OCR_SIM_MODES.includes(mode) || mode === "passthrough") {
    throw new SimOcrError("INTERNAL_ERROR", `recognizeSimulated không dùng được với mode "${mode}"`, null);
  }

  if (mode === "error") {
    // Ném ngay, không chờ: mô phỏng LLM API trả HTTP 500 → ai-server trả 502 UPSTREAM_ERROR.
    throw new SimOcrError("UPSTREAM_ERROR", "Mô phỏng: LLM API trả HTTP 500", 500);
  }
  if (mode === "timeout") {
    // Treo tới khi hết UPSTREAM_TIMEOUT_MS → server.js bắt AbortError/TimeoutError → 504.
    await hangUntilAbort(signal);
  }
  if (mode === "slow") {
    // Mặc định 25 s > timeout 20 s của BE → BE nhận 504 RECOGNITION_TIMEOUT.
    await sleep(config.ocrSimDelayMs ?? 25000, signal);
  }

  let fields = sampleFields();
  let rawText = SIM_SAMPLE_RAW_TEXT;

  if (mode === "partial") {
    fields = fields.map((f) => (PARTIAL_KEEP.includes(f.name) ? f : { name: f.name, text: null, score: 0 }));
  } else if (mode === "garbage") {
    fields = fields.map((f) =>
      f.name in GARBAGE_FIELDS_OVERRIDE ? { name: f.name, text: GARBAGE_FIELDS_OVERRIDE[f.name], score: f.score } : f,
    );
    rawText = GARBAGE_RAW_TEXT;
  }

  // model "sim-<mode>" để log và DB phân biệt rõ với model thật; usage null vì không tiêu token.
  return { model: `sim-${mode}`, fields, rawText, usage: null, retryCount: 0 };
}
