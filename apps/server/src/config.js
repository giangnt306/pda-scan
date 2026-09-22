import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");

/* Nạp apps/server/.env (nếu có) vào process.env; biến đã đặt sẵn trong môi trường được ưu tiên.
 * Tự đọc thay vì dùng --env-file để không lệ thuộc hành vi cờ này giữa các bản Node (và --watch). */
export function loadDotEnv(file = path.join(serverRoot, ".env")) {
  if (!fs.existsSync(file)) return false;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/* Mode mà provider mock tự hiểu (env MOCK_MODE). Cố ý KHÔNG mở rộng: mock không biết
 * partial/garbage/lowConfidence — mấy mode đó do sim/ocrWrapper.js áp sau khi provider trả. */
const MOCK_MODES = new Set(["success", "slow", "error", "timeout"]);
/* Mode OCR của kịch bản mô phỏng (?sim=, sim_state.ocr.mode) — áp cho cả mock lẫn http. */
const OCR_MODES = new Set(["success", "slow", "error", "timeout", "partial", "garbage", "lowConfidence"]);
const SAVE_MODES = new Set(["normal", "fail", "slow"]);
const BACKEND_MODES = new Set(["normal", "degraded", "readonly", "down"]);
const SAP_MODES = new Set(["success", "slow", "reject", "down"]);
const PROVIDERS = new Set(["mock", "http"]);
/* Adapter SAP đang dùng. Phase 4 chỉ có mock và none; http là Phase 7. */
const SAP_ADAPTERS = new Set(["mock", "none"]);
/* Phase 5: chế độ nhận dạng. sync = chờ xong mới trả (hành vi Phase 1-4, MẶC ĐỊNH);
 * async = trả 202 rồi chạy nền, PDA poll GET /api/recognitions/:id. */
const RECOGNITION_MODES = new Set(["sync", "async"]);

const DEFAULT_BACKOFFS_MS = [5000, 15000, 60000, 60000];

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Biến môi trường ${name} phải là số nguyên không âm, nhận "${raw}"`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function oneOf(name, allowed, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.has(raw)) throw new Error(`Biến môi trường ${name} phải là một trong: ${[...allowed].join(", ")}`);
  return raw;
}

/* Múi giờ kho có thể âm (châu Mỹ), nên không dùng int() — hàm đó từ chối số âm. */
function signedInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Biến môi trường ${name} phải là số nguyên, nhận "${raw}"`);
  return n;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* OUTBOX_BACKOFF_MS là CSV "5000,15000,60000,60000". Phần tử không phải số nguyên ≥ 0 bị loại;
 * rỗng sau khi lọc → dùng mặc định thay vì để worker retry tức thì vô hạn. */
export function parseBackoffs(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [...DEFAULT_BACKOFFS_MS];
  const list = raw
    .split(",")
    /* Ô rỗng ("5000,,60000" hoặc dấu phẩy thừa cuối dòng) là lỗi gõ chứ không phải "chờ 0 ms":
     * Number("") = 0 sẽ lặng lẽ biến nó thành một lần thử lại tức thì. */
    .filter((s) => s.trim() !== "")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return list.length ? list : [...DEFAULT_BACKOFFS_MS];
}

/* Đọc cấu hình từ process.env (đã được nạp bởi --env-file-if-exists=.env). */
export function loadConfig(overrides = {}) {
  if (overrides.dotenv !== false) loadDotEnv();
  const dataDir = path.resolve(serverRoot, process.env.DATA_DIR || "./data");
  const cfg = {
    host: process.env.HOST || "127.0.0.1",
    port: int("PORT", 3000),
    dataDir,
    dbPath: path.join(dataDir, "pda-scan.sqlite"),
    uploadsDir: path.join(dataDir, "uploads"),
    maxUploadBytes: int("MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    provider: oneOf("RECOGNITION_PROVIDER", PROVIDERS, "mock"),
    // 20 s là ngân sách dùng CHUNG cho cả 2 attempt (Q10), không phải 20 s mỗi attempt.
    recognitionTimeoutMs: int("RECOGNITION_TIMEOUT_MS", 20000),
    recognitionMaxAttempts: Math.max(1, int("RECOGNITION_MAX_ATTEMPTS", 2)),
    recognitionRetryBackoffMs: int("RECOGNITION_RETRY_BACKOFF_MS", 500),
    recognitionMaxConcurrent: Math.max(1, int("RECOGNITION_MAX_CONCURRENT", 3)),
    recognitionMaxWaiting: int("RECOGNITION_MAX_WAITING", 10),
    recognitionMaxWaitMs: int("RECOGNITION_MAX_WAIT_MS", 30000),
    recognitionBusyRetryAfterMs: int("RECOGNITION_BUSY_RETRY_AFTER_MS", 3000),
    /* Mặc định "sync" là bắt buộc (QUYẾT ĐỊNH A-1): bật async mặc định sẽ làm mọi test cũ của
     * POST /api/recognitions (kỳ vọng 201 + fields) đỏ hàng loạt. */
    recognitionMode: oneOf("RECOGNITION_MODE", RECOGNITION_MODES, "sync"),
    recognitionPollHintMs: clamp(int("RECOGNITION_POLL_HINT_MS", 1000), 200, 10000),
    ocrProbeTimeoutMs: int("OCR_PROBE_TIMEOUT_MS", 3000),
    requireDeviceId: bool("REQUIRE_DEVICE_ID", false),
    mock: {
      mode: oneOf("MOCK_MODE", MOCK_MODES, "success"),
      delayMs: int("MOCK_DELAY_MS", 700),
      slowDelayMs: int("MOCK_SLOW_DELAY_MS", 6000),
    },
    // Origin được phép gọi trực tiếp từ browser (CORS). Rỗng = không bật CORS (chỉ same-origin qua proxy).
    corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean),
    simOverride: bool("SIM_OVERRIDE", true),
    simSaveFail: bool("SIM_SAVE_FAIL", false),
    ai: {
      url: process.env.AI_SERVER_URL || "",
      apiKey: process.env.AI_SERVER_API_KEY || "",
      publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    },
    sap: {
      adapter: oneOf("SAP_ADAPTER", SAP_ADAPTERS, "mock"),
      timeoutMs: Math.max(1000, int("SAP_TIMEOUT_MS", 15000)),
      maxAttempts: clamp(int("SAP_MAX_ATTEMPTS", 5), 1, 10),
      mockSuccessDelayMs: int("SAP_MOCK_SUCCESS_DELAY_MS", 300),
      mockSlowDelayMs: int("SAP_MOCK_SLOW_DELAY_MS", 8000),
    },
    outbox: {
      enabled: bool("OUTBOX_ENABLED", true),
      tickMs: clamp(int("OUTBOX_TICK_MS", 1000), 20, 60000),
      backoffsMs: parseBackoffs(process.env.OUTBOX_BACKOFF_MS),
    },
    rules: {
      duplicate: bool("RULE_DUPLICATE", true),
      location: bool("RULE_LOCATION", true),
    },
    /* Sổ sự kiện toàn hệ thống cho màn hình giám sát (Phase 5 §4). */
    events: {
      enabled: bool("EVENTS_ENABLED", true),
      maxRows: clamp(int("EVENTS_MAX_ROWS", 2000), 100, 100000),
      trimEvery: clamp(int("EVENTS_TRIM_EVERY", 100), 1, 10000),
      mirrorReceipts: bool("EVENTS_MIRROR_RECEIPTS", true),
    },
    /* Danh mục tĩnh nằm trong src/ chứ không trong DATA_DIR (Q27): nó là mã nguồn có version,
     * và mọi test dùng DATA_DIR tạm sẽ không thấy nó nếu đặt cùng chỗ dữ liệu runtime. */
    masterDir: process.env.MASTER_DIR ? path.resolve(process.env.MASTER_DIR) : path.join(serverRoot, "src", "master-data"),
    /* Khoá nghiệp vụ "cùng ngày" đếm theo ngày ĐỊA PHƯƠNG của kho (Q32 bị bác bỏ bản UTC):
     * 00:00 UTC rơi vào giữa ca sáng ở Việt Nam. Mọi mốc thời gian LƯU TRỮ vẫn là UTC. */
    tzOffsetMinutes: signedInt("TZ_OFFSET_MINUTES", 420),
  };
  return {
    ...cfg,
    ...overrides,
    mock: { ...cfg.mock, ...(overrides.mock || {}) },
    ai: { ...cfg.ai, ...(overrides.ai || {}) },
    sap: { ...cfg.sap, ...(overrides.sap || {}) },
    outbox: { ...cfg.outbox, ...(overrides.outbox || {}) },
    rules: { ...cfg.rules, ...(overrides.rules || {}) },
    events: { ...cfg.events, ...(overrides.events || {}) },
  };
}

export { MOCK_MODES, OCR_MODES, SAVE_MODES, BACKEND_MODES, SAP_MODES, SAP_ADAPTERS, RECOGNITION_MODES };
