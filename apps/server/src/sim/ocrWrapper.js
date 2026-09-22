/* Bọc provider nhận dạng (mock HAY http) để áp 7 mode OCR của kịch bản mô phỏng.
 *
 * Wrapper thao tác trên result.fields — tức là output TRƯỚC khi normalizeRecognitionFields
 * chạy (dạng { formKey: { value, confidence } }). Nhờ vậy "partial" cho ra status "missing"
 * đúng như provider thật không đọc được, chứ không phải một nhánh giả trong service. */

export const PARTIAL_DROP = ["partNumber", "shipmentDate", "supplier"];
export const GARBAGE_VALUES = {
  partNumber: "X#@!9-??",
  partName: "▒▒▒ĐỌC KHÔNG RA▒▒▒",
  quantity: "??",
};
export const LOW_CONFIDENCE = 0.3;
export const SLOW_MIN_MS = 6000;

/* Mọi sleep trong đường nhận dạng phải huỷ được, nếu không request đã timeout vẫn giữ
 * slot semaphore cho tới khi timer chạy hết. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
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

function applyPartial(fields) {
  for (const key of PARTIAL_DROP) delete fields[key];
}

function applyGarbage(fields) {
  for (const [key, value] of Object.entries(GARBAGE_VALUES)) {
    fields[key] = { ...(fields[key] || {}), value };
  }
}

/* §6.2: đặt confidence = 0.3 cho MỌI TRƯỜNG CÓ MẶT TRONG KẾT QUẢ provider — và chỉ những
 * trường đó. Wrapper chạy TRƯỚC normalizeRecognitionFields, nên sau khi chuẩn hoá:
 *   - trường provider không trả  → status "missing",  confidence 0 (chưa bao giờ có 0.3 để giữ);
 *   - trường có raw nhưng không ép được kiểu → status "unparsed", confidence bị hạ về 0.
 * Cố tình KHÔNG ép 0.3 sau chuẩn hoá: confidence là "độ tin của giá trị đã đọc được", gắn 0.3
 * cho một trường value=null là nói dối UI (nó sẽ hiện "đọc được, hơi thiếu chắc" thay vì "không
 * đọc được"). Kịch bản lowConfidence cần đúng một hiệu ứng: cả form vàng cờ "kiểm tra lại". */
function applyLowConfidence(fields) {
  for (const key of Object.keys(fields)) {
    if (fields[key] && typeof fields[key] === "object") fields[key] = { ...fields[key], confidence: LOW_CONFIDENCE };
  }
}

/* getSim(args) → { mode, delayMs }. Truyền qua args để mỗi request dùng đúng kịch bản của
 * chính nó (global / device / ?sim=) mà provider vẫn là một instance dùng chung. */
export function wrapProviderWithSim(provider, getSim, { slowMinMs = SLOW_MIN_MS } = {}) {
  const read = (args) => {
    const s = (typeof getSim === "function" ? getSim(args) : getSim) || {};
    return { mode: s.mode || "success", delayMs: Math.max(0, Number(s.delayMs) || 0) };
  };

  return {
    // Giữ nguyên tên provider gốc: /api/health và response nhận dạng vẫn báo "mock"/"http".
    get name() {
      return provider.name;
    },

    async recognize(args) {
      const { mode, delayMs } = read(args);
      const signal = args?.signal;

      // timeout: treo tới khi signal abort. Timer có ref để event loop không thoát sớm.
      if (mode === "timeout") {
        await sleep(2 ** 31 - 1, signal);
        return null; // không bao giờ tới đây
      }
      if (mode === "error") {
        throw Object.assign(new Error("Mô phỏng: dịch vụ OCR trả lỗi 500"), { code: "PROVIDER_ERROR" });
      }
      if (mode === "slow") await sleep(Math.max(delayMs, slowMinMs), signal);
      else if (delayMs > 0) await sleep(delayMs, signal);

      /* Provider được gọi ở chế độ bình thường: mọi hiệu ứng hỏng đều do wrapper áp, nên
       * hành vi giống hệt nhau giữa provider mock và http. */
      const result = await provider.recognize({ ...args, options: { ...(args?.options || {}), mode: "success" } });
      const fields = result?.fields && typeof result.fields === "object" ? { ...result.fields } : {};

      if (mode === "partial") applyPartial(fields);
      if (mode === "garbage") applyGarbage(fields);
      if (mode === "lowConfidence") applyLowConfidence(fields);

      return { ...result, fields };
    },
  };
}
