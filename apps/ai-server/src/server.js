import http from "node:http";
import { randomUUID } from "node:crypto";
import { recognizeWithLlm, UpstreamError } from "./ocr.js";
import { recognizeSimulated, SimOcrError } from "./sim.js";

const MAGIC = [
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];
const sniff = (b) => (b && b.length >= 12 ? MAGIC.find((m) => m.test(b))?.mime ?? null : null);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return reject(new ApiError(413, "PAYLOAD_TOO_LARGE", `Body vượt ${limit} byte`));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        return reject(new ApiError(413, "PAYLOAD_TOO_LARGE", `Body vượt ${limit} byte`));
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const log = (level, msg, extra = {}) =>
  (level === "error" ? process.stderr : process.stdout).write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }) + "\n");

export function createServer(config, { fetchImpl, logger = { info: (m, e) => log("info", m, e), warn: (m, e) => log("warn", m, e), error: (m, e) => log("error", m, e) } } = {}) {
  const simMode = config.ocrSimMode || "passthrough";
  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://local");
    // Truy vết xuyên FE → BE → ai-server. Thiếu header thì tự sinh, không báo lỗi.
    // setHeader ngay từ đầu để MỌI response (kể cả 404/405/415/502) đều mang x-request-id.
    const incomingRequestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].trim() : "";
    const requestId = incomingRequestId || randomUUID();
    res.setHeader("x-request-id", requestId);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        // ⚠️ Giữ nguyên ok/model/baseUrl/configured/authRequired — BE probe đọc configured và model.
        // ĐÍNH CHÍNH R7 — tách hai khái niệm, đừng gộp làm một:
        //   configured = CÓ OPENAI_API_KEY hay không (chỉ mang tính thông tin);
        //   ready      = CÓ PHỤC VỤ ĐƯỢC /recognize hay không.
        // Ở cấu hình demo không tốn quota (OCR_SIM_MODE khác passthrough, không có key) thì
        // /recognize vẫn trả 200, nên ready = true dù configured = false. Trước đây BE chỉ đọc
        // configured nên PDA bật đèn OCR ĐỎ + "Dịch vụ đọc nhãn không sẵn sàng" — sai sự thật.
        // FE quyết định màu đèn bằng ready, không phải configured.
        const configured = Boolean(config.apiKey);
        const ready = configured || simMode !== "passthrough";
        return sendJson(res, 200, { ok: true, model: config.model, baseUrl: config.baseUrl, configured, ready, authRequired: Boolean(config.sharedSecret), simMode, upstreamTimeoutMs: config.upstreamTimeoutMs });
      }
      if (url.pathname !== "/recognize") throw new ApiError(404, "NOT_FOUND", "Không có đường dẫn này");
      if (req.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Dùng POST");

      if (config.sharedSecret && req.headers.authorization !== `Bearer ${config.sharedSecret}`) {
        throw new ApiError(401, "UNAUTHORIZED", "Thiếu hoặc sai AI_SERVER_API_KEY");
      }
      const ct = req.headers["content-type"] || "";
      if (!ct.startsWith("multipart/form-data")) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Cần multipart/form-data với field 'image'");
      const buf = await readBody(req, config.maxUploadBytes + 64 * 1024);
      let form;
      try {
        form = await new Request("http://local/x", { method: "POST", headers: { "content-type": ct }, body: buf }).formData();
      } catch {
        throw new ApiError(400, "INVALID_MULTIPART", "Không đọc được multipart");
      }
      const file = form.get("image");
      if (!file || typeof file === "string") throw new ApiError(400, "IMAGE_REQUIRED", "Thiếu field 'image'");
      const image = Buffer.from(await file.arrayBuffer());
      if (image.length > config.maxUploadBytes) throw new ApiError(413, "IMAGE_TOO_LARGE", `Ảnh vượt ${config.maxUploadBytes} byte`);
      const mimeType = sniff(image);
      if (!mimeType) throw new ApiError(415, "UNSUPPORTED_IMAGE", "Chỉ nhận JPEG/PNG/WebP");
      const recognitionId = typeof form.get("recognitionId") === "string" ? form.get("recognitionId") : null;

      logger.info("ocr.start", { requestId, recognitionId, bytes: image.length, model: config.model, simMode });
      // Một signal duy nhất cho cả 2 attempt (QUYẾT ĐỊNH AI-2): tổng thời gian không vượt
      // upstreamTimeoutMs, đúng bằng ngân sách BE đang chờ.
      const signal = AbortSignal.timeout(config.upstreamTimeoutMs);
      const deadlineAt = t0 + config.upstreamTimeoutMs;
      // simMode khác passthrough → KHÔNG gọi OpenAI và KHÔNG cần OPENAI_API_KEY.
      const result =
        simMode === "passthrough"
          ? await recognizeWithLlm({ imageBuffer: image, mimeType, config, signal, fetchImpl, logger, requestId, deadlineAt })
          : await recognizeSimulated({ mode: simMode, config, signal });
      const durationMs = Date.now() - t0;
      const retryCount = result.retryCount ?? 0;
      logger.info("ocr.done", { requestId, recognitionId, durationMs, found: result.fields.filter((f) => f.text).length, model: result.model, modelRequested: config.model, simMode, retryCount, usage: result.usage ?? null });
      sendJson(res, 200, { recognitionId, requestId, durationMs, model: result.model, simMode, retryCount, fields: result.fields, rawText: result.rawText, usage: result.usage ?? null });
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      // SimOcrError xử lý y như UpstreamError để BE không phân biệt được thật/giả.
      if (err instanceof UpstreamError || err instanceof SimOcrError) {
        const status = err.code === "NOT_CONFIGURED" ? 503 : 502;
        logger.warn("ocr.failed", { requestId, code: err.code, status: err.status, message: err.message, simMode, retryCount: err.retryCount ?? 0, upstream: err.body });
        return sendJson(res, status, { error: { code: err.code, message: err.message, upstreamStatus: err.status ?? null } });
      }
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        logger.warn("ocr.timeout", { requestId, ms: Date.now() - t0, simMode });
        return sendJson(res, 504, { error: { code: "UPSTREAM_TIMEOUT", message: `LLM không phản hồi trong ${config.upstreamTimeoutMs} ms` } });
      }
      logger.error("ocr.unhandled", { requestId, message: err?.message, stack: err?.stack });
      sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: "Lỗi không mong đợi" } });
    }
  });
}
