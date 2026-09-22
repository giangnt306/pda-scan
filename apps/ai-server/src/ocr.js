/* Gọi LLM có vision qua API Chat Completions chuẩn OpenAI để đọc nhãn.
 * Tương thích: OpenAI (gpt-4o-mini…), Gemini (endpoint /v1beta/openai), OpenRouter, Ollama…
 *
 * Đầu ra chuẩn của AI server (Main BE ánh xạ tiếp trong providers/http.js):
 *   { model, fields: [ { name, text, score } ], rawText, usage }
 *   - name : tên trường theo snake_case bên dưới (KHÔNG cần trùng key form)
 *   - text : chuỗi đúng như in trên nhãn, không tự đổi định dạng ngày/số
 *   - score: 0..1 do model tự ước lượng
 */

import { sleep } from "./sim.js";

export const FIELD_SPECS = [
  { name: "part_number", hint: "Part Number / Part No / P/N. Định dạng chuẩn 3 chữ cái + ĐÚNG 8 chữ số + 2-6 chữ cái (ví dụ BEX32181030AB, BEX75149000AB). Đếm kỹ số chữ số, không thêm/bớt số 0." },
  { name: "part_name", hint: "Tên linh kiện / Description / Part Name, ví dụ BATTERY_PACK_REAR_FENDER" },
  { name: "qty", hint: "Số lượng / Quantity / QTY (chỉ con số)" },
  { name: "ship_date", hint: "Ngày xuất hàng / Ship date / Date, ghi đúng như trên nhãn (15/9/2026, 18SEP2026, 2026/8/21...)" },
  { name: "supplier", hint: "Nhà cung cấp / Supplier / Vendor / Made in. Nếu nhãn không ghi rõ nhưng có logo/tên hãng (ví dụ VINFAST) thì ghi tên hãng đó." },
  { name: "sa_number", hint: "SA Number / SA No, 10 chữ số" },
  { name: "variant", hint: "Phiên bản / Màu / Model variant, ví dụ VF8 NP, Limo Green" },
  { name: "plant_dock", hint: "Plant / Dock, ví dụ 3001/1001" },
  { name: "batch", hint: "Batch / Lot, ví dụ 260917_79F" },
  { name: "gross_weight", hint: "Gross weight (kg), chỉ con số" },
];

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", enum: FIELD_SPECS.map((f) => f.name) },
          text: { type: ["string", "null"] },
          score: { type: "number" },
        },
        required: ["name", "text", "score"],
      },
    },
    raw_text: { type: "string" },
  },
  required: ["fields", "raw_text"],
};

export function buildMessages({ imageDataUrl, detail }) {
  const fieldList = FIELD_SPECS.map((f) => `- ${f.name}: ${f.hint}`).join("\n");
  const system = [
    "Bạn là bộ OCR cho nhãn linh kiện ô tô trong kho.",
    "Đọc ảnh nhãn và trích xuất các trường dưới đây. Trả về JSON đúng schema, không giải thích.",
    "Quy tắc:",
    "- text: chép đúng chuỗi in trên nhãn (giữ nguyên định dạng ngày, dấu phẩy/chấm thập phân, hoa/thường). Không suy diễn, không tự sửa.",
    "- Trường không thấy trên nhãn hoặc ô để trống: text = null, score = 0. KHÔNG điền đơn vị (KG, PCS) hay dấu chấm thay cho ô trống. Luôn liệt kê đủ mọi trường.",
    "- Mỗi chuỗi trên nhãn chỉ thuộc một trường. Không chép giá trị của batch/part_number sang variant; variant chỉ điền khi nhãn có tên phiên bản/màu riêng (VF8 NP, Limo Green…).",
    "- score: 0..1, độ tin cậy bạn đọc đúng chuỗi đó (chữ in rõ ≈ 0.9+, viết tay/mờ ≈ 0.5-0.7).",
    "- raw_text: 10 dòng chữ quan trọng nhất đọc được trên nhãn, mỗi dòng một chuỗi, tối đa 10 dòng, bỏ qua mã vạch.",
    "Các trường:",
    fieldList,
  ].join("\n");
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: "Đọc nhãn trong ảnh này." },
        { type: "image_url", image_url: { url: imageDataUrl, detail } },
      ],
    },
  ];
}

export class UpstreamError extends Error {
  constructor(code, message, { status, body } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/* Trích JSON từ nội dung trả về (một số model bọc trong ```json ... ```). */
export function extractJson(text) {
  if (typeof text !== "string") throw new UpstreamError("BAD_RESPONSE", "LLM không trả text");
  const snippet = text.slice(0, 300);
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* rơi xuống */
      }
    }
    throw new UpstreamError("BAD_RESPONSE", "LLM trả về không phải JSON hợp lệ", { body: snippet });
  }
}

/* Chuẩn hoá output của model về contract AI server. Chịu được model trả object thay vì list. */
export function normalizeModelOutput(obj, model) {
  const known = new Set(FIELD_SPECS.map((f) => f.name));
  const byName = new Map();
  const src = obj?.fields;
  if (Array.isArray(src)) {
    for (const f of src) if (f && known.has(f.name)) byName.set(f.name, f);
  } else if (src && typeof src === "object") {
    for (const [name, v] of Object.entries(src)) {
      if (!known.has(name)) continue;
      byName.set(name, v && typeof v === "object" ? { name, text: v.text ?? v.value ?? null, score: v.score ?? v.confidence } : { name, text: v, score: undefined });
    }
  }
  const fields = FIELD_SPECS.map(({ name }) => {
    const f = byName.get(name);
    let text = f?.text === undefined || f?.text === null ? null : String(f.text).trim() || null;
    // Ô trống trên nhãn: model hay trả đơn vị ("KG"), dấu chấm ("....") hoặc "N/A" → coi là không có.
    if (text && (/^(kg|kgs|g|pcs|pc|cái|chiếc|n\/a|na|none|null|-+|\.+|_+)$/i.test(text) || /^[.\s_/-]*\/?\s*\d{0,4}$/.test(text) && !/^\d+$/.test(text))) text = null;
    let score = Number(f?.score);
    if (!Number.isFinite(score)) score = text ? 0.5 : 0;
    score = Math.min(1, Math.max(0, score > 1 ? score / 100 : score));
    return { name, text, score: text ? score : 0 };
  });
  // Cắt cứng phía server: không tin model tuân thủ "tối đa 10 dòng" trong prompt.
  const rawText = typeof obj?.raw_text === "string" ? obj.raw_text.split("\n").slice(0, 10).join("\n") : "";
  return { model, fields, rawText };
}

/* Lỗi tạm thời — thử lại một lần có ích: 429 (rate limit), 5xx, JSON hỏng, bị cắt vì max_tokens,
 * và lỗi kết nối (fetch ném TypeError). Không retry 400/401/403 (lỗi của ta) và NOT_CONFIGURED. */
const RETRYABLE_CODES = new Set(["BAD_RESPONSE", "TRUNCATED"]);
const retryableStatus = (s) => s === 429 || (s >= 500 && s <= 599);
/* Chỉ retry khi còn ít nhất ngần này thời gian trong ngân sách chung — gọi lại rồi bị abort
 * giữa chừng thì vừa tốn tiền vừa không có kết quả (QUYẾT ĐỊNH AI-2). */
const RETRY_MIN_BUDGET_MS = 2000;
/* HAI CƠ CHẾ TÁCH BẠCH — đừng gộp:
 *
 *   (1) LÙI ĐỊNH DẠNG (format fallback, ngay dưới đây): lần gọi đầu dùng
 *       response_format: json_schema; nếu upstream trả HTTP 400 thì gọi LẠI ĐÚNG MỘT LẦN với
 *       response_format: json_object. Đây KHÔNG phải retry: không tính vào retryCount, không
 *       backoff, không phụ thuộc upstreamMaxAttempts.
 *   (2) RETRY LỖI TẠM (isRetryableError + vòng for): 429 / 5xx / JSON hỏng / TRUNCATED / lỗi kết nối,
 *       có backoff và bị giới hạn bởi upstreamMaxAttempts + ngân sách còn lại.
 *
 * Vì sao lùi với MỌI 400 chứ không chỉ khi nội dung lỗi khớp một mẫu chữ: mỗi nhà cung cấp viết
 * body 400 một kiểu (vLLM "guided_json is not enabled", Azure "Structured outputs are not
 * available...", có nơi trả body RỖNG hoặc HTML). Lọc theo mẫu chữ làm mất hẳn nhánh lùi ở 3 kiểu
 * 400 thật đã tái hiện được, tức là phá cam kết "đổi nhà cung cấp chỉ cần đổi 3 biến env, không
 * sửa code" của README. Giá phải trả khi 400 là lỗi thật của ta (ảnh hỏng, sai tên model):
 * đúng MỘT lời gọi thừa, rồi lỗi 400 thứ hai được ném ra nguyên vẹn. Đổi lại là tính di động.
 */

export function isRetryableError(err) {
  // Ngân sách của ta hết → retry vô nghĩa, upstream cũng đã bị huỷ.
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return false;
  if (err instanceof UpstreamError) {
    if (RETRYABLE_CODES.has(err.code)) return true;
    return typeof err.status === "number" && retryableStatus(err.status);
  }
  return err instanceof TypeError; // fetch failed / ECONNREFUSED
}

/* Gọi chat completions. Thử json_schema trước; bất kỳ HTTP 400 nào ở lần gọi đầu → lùi về
 * json_object ĐÚNG MỘT LẦN (không tính là retry, xem ghi chú "HAI CƠ CHẾ TÁCH BẠCH" ở trên).
 * Retry lỗi tạm tối đa UPSTREAM_MAX_ATTEMPTS lần, dùng CHUNG một signal/ngân sách do server.js tạo. */
export async function recognizeWithLlm({ imageBuffer, mimeType, config, signal, fetchImpl = globalThis.fetch, logger = null, requestId = null, deadlineAt = null }) {
  if (!config.apiKey) throw new UpstreamError("NOT_CONFIGURED", "Chưa đặt OPENAI_API_KEY cho AI server");
  const imageDataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
  const messages = buildMessages({ imageDataUrl, detail: config.imageDetail });
  const maxTokens = config.maxOutputTokens ?? 900;
  const maxAttempts = Math.max(1, config.upstreamMaxAttempts ?? 2);
  const backoffMs = config.upstreamRetryBackoffMs ?? 500;
  const deadline = deadlineAt ?? Date.now() + (config.upstreamTimeoutMs ?? 18000);

  const call = async (responseFormat) => {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, temperature: 0, max_tokens: maxTokens, messages, response_format: responseFormat }),
      signal,
    });
    const body = await res.text();
    if (!res.ok) throw new UpstreamError("UPSTREAM_ERROR", `LLM API trả HTTP ${res.status}`, { status: res.status, body: body.slice(0, 500) });
    try {
      return JSON.parse(body);
    } catch {
      // HTTP 200 nhưng envelope không phải JSON (proxy chèn HTML, kết nối đứt giữa chừng):
      // gói thành BAD_RESPONSE để được retry và để BE thấy 502 có mã lỗi, không phải 500.
      throw new UpstreamError("BAD_RESPONSE", "LLM trả về không phải JSON hợp lệ", { status: res.status, body: body.slice(0, 300) });
    }
  };

  // Nhớ format đã dùng được: nếu attempt 1 phải lùi về json_object thì attempt 2 đi thẳng json_object.
  let responseFormat = { type: "json_schema", json_schema: { name: "label_ocr", strict: true, schema: RESPONSE_SCHEMA } };
  let retryCount = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      let data;
      try {
        data = await call(responseFormat);
      } catch (err) {
        // (1) Lùi định dạng. Điều kiện `responseFormat.type === "json_schema"` là thứ bảo đảm
        // chỉ lùi ĐÚNG MỘT LẦN: sau khi gán json_object, một 400 tiếp theo sẽ rơi xuống `throw`.
        if (err instanceof UpstreamError && err.status === 400 && responseFormat.type === "json_schema") {
          logger?.warn?.("ocr.format_fallback", { requestId, attempt, from: "json_schema", to: "json_object", upstreamStatus: 400 });
          responseFormat = { type: "json_object" };
          data = await call(responseFormat);
        } else throw err;
      }

      const choice = data?.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new UpstreamError("TRUNCATED", "LLM trả về bị cắt (vượt max_tokens); nhãn quá nhiều chữ", { body: String(choice?.message?.content || "").slice(0, 300) });
      }
      const parsed = extractJson(choice?.message?.content);
      return { ...normalizeModelOutput(parsed, data?.model || config.model), usage: data?.usage ?? null, retryCount };
    } catch (err) {
      const budgetLeftMs = deadline - Date.now();
      const canRetry = attempt < maxAttempts && isRetryableError(err) && !signal?.aborted && budgetLeftMs >= RETRY_MIN_BUDGET_MS;
      if (!canRetry) {
        if (err instanceof UpstreamError) err.retryCount = retryCount;
        throw err;
      }
      retryCount += 1;
      logger?.warn?.("ocr.retry", { requestId, attempt, reason: err?.code ?? err?.status ?? err?.name ?? "unknown", waitedMs: backoffMs });
      await sleep(backoffMs, signal);
    }
  }
}
