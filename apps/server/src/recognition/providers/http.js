/* Provider HTTP gọi AI server (apps/ai-server hoặc bất kỳ dịch vụ OCR nào cùng contract).
 *
 * Cùng contract với mock: recognize({ recognitionId, image, options, signal }) → { raw, fields }.
 * Gửi multipart: image (binary), recognitionId, imageUrl (nếu có PUBLIC_BASE_URL).
 * Header Authorization: Bearer <AI_SERVER_API_KEY> nếu cấu hình.
 *
 * mapAiResponse() ánh xạ response AI về { formKey: { value, confidence } }. AI server không
 * cần biết key của form; service sẽ ép kiểu, so enum, parse ngày, hạ confidence.
 */

/* Tên field phía AI server (snake_case) → key form. Key đã là camelCase của form thì giữ nguyên. */
export const NAME_MAP = {
  part_number: "partNumber",
  part_name: "partName",
  qty: "quantity",
  quantity: "quantity",
  ship_date: "shipmentDate",
  shipment_date: "shipmentDate",
  supplier: "supplier",
  sa_number: "saNumber",
  variant: "variant",
  plant_dock: "plantDock",
  batch: "batch",
  gross_weight: "grossWeight",
  location: "location",
  packaging: "packaging",
  note: "note",
};

/* Lỗi đáng thử lại: upstream còn sống nhưng vừa hỏng nhất thời. KHÔNG retry khi upstream
 * đã hết giờ (504 / UPSTREAM_TIMEOUT) hoặc khi lỗi là của chính ta (400/401/413/415, thiếu key). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
const RETRYABLE_UPSTREAM_CODES = new Set(["BAD_RESPONSE", "TRUNCATED"]);
export const RETRY_MIN_REMAINING_MS = 2000;

export function isRetryableProviderError(err) {
  if (!err) return false;
  if (err.code === "UPSTREAM_TIMEOUT" || err.code === "PROVIDER_NOT_CONFIGURED") return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return false;
  if (err.upstreamCode === "NOT_CONFIGURED") return false;
  if (err.upstreamCode && RETRYABLE_UPSTREAM_CODES.has(err.upstreamCode)) return true;
  if (typeof err.status === "number") return RETRYABLE_STATUS.has(err.status);
  return err.code === "PROVIDER_ERROR"; // lỗi kết nối / JSON hỏng
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  });
}

export function createHttpProvider({
  url,
  apiKey,
  fetchImpl = globalThis.fetch,
  maxAttempts = 2,
  backoffMs = 500,
  deadlineAt = null,
  logger = null,
} = {}) {
  async function attempt({ recognitionId, image, signal, requestId }) {
    const form = new FormData();
    form.append("recognitionId", recognitionId);
    form.append("image", new Blob([await image.getBuffer()], { type: image.mimeType }), `${image.id}.bin`);
    if (image.publicUrl) form.append("imageUrl", image.publicUrl);

    const headers = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    // Truy vết xuyên tầng: cùng một x-request-id chạy từ PDA → BE → ai-server → log LLM.
    if (requestId) headers["x-request-id"] = requestId;

    let res;
    try {
      res = await fetchImpl(url, { method: "POST", body: form, headers, signal });
    } catch (err) {
      if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
      throw Object.assign(new Error(`Không kết nối được AI server tại ${url}`), { code: "PROVIDER_ERROR", cause: err });
    }
    if (!res.ok) {
      // Lấy message của AI server (nếu là JSON {error:{code,message}}) để lỗi phía BE dễ hiểu.
      let detail = "";
      let upstreamCode = null;
      try {
        const body = await res.json();
        upstreamCode = body?.error?.code ?? null;
        detail = body?.error?.message ? ` — ${body.error.code || ""} ${body.error.message}`.trimEnd() : "";
      } catch {
        /* không phải JSON */
      }
      /* Upstream hết giờ là tình trạng KHÁC hẳn upstream hỏng: PDA cần thấy 504
       * RECOGNITION_TIMEOUT để biết "ảnh vẫn còn, thử lại được", không phải 502. */
      const timedOut = res.status === 504 || upstreamCode === "UPSTREAM_TIMEOUT";
      throw Object.assign(new Error(`AI server trả HTTP ${res.status}${detail}`), {
        code: timedOut ? "UPSTREAM_TIMEOUT" : "PROVIDER_ERROR",
        status: res.status,
        upstreamCode,
      });
    }
    let raw;
    try {
      raw = await res.json();
    } catch (err) {
      throw Object.assign(new Error("AI server trả body không phải JSON"), { code: "PROVIDER_ERROR", cause: err });
    }
    return { raw, fields: mapAiResponse(raw) };
  }

  return {
    name: "http",
    async recognize(args) {
      if (!url) {
        throw Object.assign(new Error("RECOGNITION_PROVIDER=http nhưng chưa đặt AI_SERVER_URL"), {
          code: "PROVIDER_NOT_CONFIGURED",
        });
      }
      const budgetEnd = args?.deadlineAt ?? deadlineAt;
      for (let n = 1; ; n += 1) {
        try {
          return await attempt(args);
        } catch (err) {
          const remaining = budgetEnd === null ? Infinity : budgetEnd - Date.now();
          // Retry chỉ có nghĩa khi còn đủ thời gian để lần thử sau kịp trả lời.
          if (n >= maxAttempts || !isRetryableProviderError(err) || remaining < RETRY_MIN_REMAINING_MS) throw err;
          logger?.warn("provider.retry", {
            requestId: args?.requestId ?? null,
            recognitionId: args?.recognitionId ?? null,
            attempt: n,
            reason: err.upstreamCode || err.status || err.code,
          });
          await sleep(backoffMs, args?.signal);
        }
      }
    },
  };
}

/* Chấp nhận:
 *   { fields: [ { name, text|value, score|confidence } ] }   — contract của apps/ai-server
 *   { fields: { partNumber: { value, confidence } } }        — dạng object theo key form
 * Trường có text/value null hoặc rỗng bị bỏ (service sẽ đánh dấu missing).
 */
export function mapAiResponse(raw) {
  const out = {};
  const put = (name, value, confidence) => {
    const key = NAME_MAP[name] ?? name;
    if (value === null || value === undefined || String(value).trim() === "") return;
    out[key] = { value, confidence };
  };
  const src = raw?.fields;
  if (Array.isArray(src)) {
    for (const f of src) if (f?.name) put(f.name, f.value ?? f.text, f.confidence ?? f.score);
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object") put(k, v.value ?? v.text, v.confidence ?? v.score);
      else put(k, v, undefined);
    }
  }
  return out;
}
