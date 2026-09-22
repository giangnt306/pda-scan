import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OCR_SIM_MODES } from "./sim.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadDotEnv(file = path.join(root, ".env")) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} phải là số nguyên không âm`);
  return n;
};

/* Fail-fast cho env dạng enum: sai chính tả phải báo ngay lúc khởi động, kèm đủ giá trị hợp lệ,
 * chứ không im lặng chạy sai mode (cùng phong cách với apps/server/src/config.js). */
const oneOf = (name, allowed, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.includes(raw)) throw new Error(`${name} phải là một trong: ${allowed.join(", ")}`);
  return raw;
};

export function loadConfig(overrides = {}) {
  if (overrides.dotenv !== false) loadDotEnv();
  return {
    host: process.env.HOST || "127.0.0.1",
    port: int("PORT", 8000),
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    sharedSecret: process.env.AI_SERVER_API_KEY || "",
    // ĐÍNH CHÍNH R2 — chuỗi timeout phải GIẢM DẦN từ ngoài vào trong:
    // webapp 60000 > Main BE 20000 > ai-server 18000 > (LLM).
    // Trước đây để 20000 = đúng bằng BE, nên BE luôn bỏ cuộc TRƯỚC ai-server và nhánh ánh xạ
    // UPSTREAM_TIMEOUT → RECOGNITION_TIMEOUT thành code chết. Đệm 2000 ms đủ để ai-server kịp
    // trả lỗi có cấu trúc (504 UPSTREAM_TIMEOUT) về BE trước khi BE tự hết hạn.
    // LLM thật đo được p50 5,3 s · p90 7,6 s · max 15,2 s nên 18 s vẫn dư.
    upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 18000),
    upstreamMaxAttempts: int("UPSTREAM_MAX_ATTEMPTS", 2),
    upstreamRetryBackoffMs: int("UPSTREAM_RETRY_BACKOFF_MS", 500),
    // 900 thay cho 1500 hard-code: completion thật ~210 token, vẫn dư gấp 4 lần nhưng
    // giảm rủi ro finish_reason="length" (TRUNCATED) bị tính tiền cho output vô ích.
    maxOutputTokens: int("MAX_OUTPUT_TOKENS", 900),
    // Giả lập dịch vụ OCR hỏng mà KHÔNG gọi OpenAI (xem src/sim.js).
    ocrSimMode: oneOf("OCR_SIM_MODE", OCR_SIM_MODES, "passthrough"),
    ocrSimDelayMs: int("OCR_SIM_DELAY_MS", 25000),
    maxUploadBytes: int("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    imageDetail: process.env.IMAGE_DETAIL || "high",
    ...overrides,
  };
}
