import fs from "node:fs";
import { SIM_DEFAULT } from "./sim/engine.js";

/* GET /api/status — kênh trạng thái ngược. Đây là đường sống duy nhất để PDA biết chuyện
 * gì đang xảy ra, nên endpoint này không bao giờ bị sim middleware chặn (§8.1). */

export const OCR_PROBE_TTL_MS = 10_000;
export const MOCK_MODEL = "mock-vlm-0";

/* Timeout nhận dạng của webapp (§11, hằng số của FE). BE chỉ dùng để kiểm tra bất đẳng thức R2. */
export const WEBAPP_RECOGNITION_TIMEOUT_MS = 60_000;

/* ĐÍNH CHÍNH R2: chuỗi timeout phải GIẢM DẦN từ ngoài vào trong —
 * webapp (60000) > BE (RECOGNITION_TIMEOUT_MS) > ai-server (UPSTREAM_TIMEOUT_MS).
 * upstreamTimeoutMs = null nghĩa là ai-server không khai báo (bản cũ): bỏ qua vế đó,
 * KHÔNG đoán giá trị. Trả { ok, problems } để gọi được từ test mà không cần dựng server. */
export function checkTimeoutChain({
  recognitionTimeoutMs,
  upstreamTimeoutMs = null,
  webappTimeoutMs = WEBAPP_RECOGNITION_TIMEOUT_MS,
} = {}) {
  const problems = [];
  if (!(webappTimeoutMs > recognitionTimeoutMs)) problems.push("webapp_le_backend");
  if (upstreamTimeoutMs !== null && !(recognitionTimeoutMs > upstreamTimeoutMs)) problems.push("backend_le_upstream");
  return { ok: problems.length === 0, problems, webappTimeoutMs, recognitionTimeoutMs, upstreamTimeoutMs };
}

/* Export để app.js dùng lại cho detail.version của sự kiện server.start — một nguồn duy nhất. */
export function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

const BACKEND_STATE = { normal: "up", degraded: "degraded", readonly: "readonly", down: "down" };

export function createStatusService({
  config,
  recognition,
  sim,
  outbox,
  fetchImpl = globalThis.fetch,
  startedAt = Date.now(),
  now = () => Date.now(),
  logger,
}) {
  const version = readVersion();
  /* Cache probe: PDA poll 10 s/lần và có thể có nhiều PDA — không thể để mỗi lần poll là
   * một lần gọi mạng sang ai-server. inflight gom các request trùng nhịp vào một probe. */
  let cache = { at: 0, result: null, inflight: null };

  const healthUrl = () => {
    if (!config.ai.url) return null;
    try {
      return new URL("/health", config.ai.url).toString();
    } catch {
      return null;
    }
  };

  async function runProbe() {
    const url = healthUrl();
    const startedProbeAt = Date.now();
    const failed = {
      reachable: false,
      configured: false,
      ready: false,
      simMode: null,
      model: null,
      latencyMs: null,
      upstreamTimeoutMs: null,
      checkedAt: new Date().toISOString(),
    };
    if (!url) return failed;
    try {
      const res = await fetchImpl(url, {
        headers: config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {},
        signal: AbortSignal.timeout(config.ocrProbeTimeoutMs ?? 3000),
      });
      const latencyMs = Date.now() - startedProbeAt;
      if (!res.ok) return { ...failed, latencyMs, checkedAt: new Date().toISOString() };
      const body = await res.json();
      const configured = Boolean(body?.configured);
      const simMode = typeof body?.simMode === "string" && body.simMode ? body.simMode : null;
      /* ĐÍNH CHÍNH R7: đèn OCR của PDA quyết định bằng `ready` (phục vụ được), không phải
       * `configured` (có OPENAI_API_KEY). ai-server bản cũ chưa có `ready` → suy ra bằng
       * `configured` đúng như hành vi trước đây, không đoán thêm. */
      const ready = typeof body?.ready === "boolean" ? body.ready : configured;
      return {
        reachable: true,
        configured,
        ready,
        simMode,
        // Đang mô phỏng thì model thật là sim-<mode>; trả tên model LLM ở đây là nói dối tầng trên.
        model: simMode && simMode !== "passthrough" ? `sim-${simMode}` : (body?.model ?? null),
        latencyMs,
        // Chỉ dùng để cảnh báo chuỗi timeout (R2); không lọt vào response /api/status.
        upstreamTimeoutMs: Number.isInteger(body?.upstreamTimeoutMs) && body.upstreamTimeoutMs > 0 ? body.upstreamTimeoutMs : null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Probe KHÔNG BAO GIỜ ném ra ngoài: /api/status phải trả lời được kể cả khi OCR chết.
      logger?.warn("ocr.probe_failed", { error: err?.message });
      return { ...failed, checkedAt: new Date().toISOString() };
    }
  }

  async function probeOcr() {
    if (config.provider !== "http") {
      return {
        reachable: true,
        configured: true,
        // Provider mock luôn phục vụ được và không có ai-server nào để hỏi simMode.
        ready: true,
        simMode: null,
        model: MOCK_MODEL,
        latencyMs: 0,
        upstreamTimeoutMs: null,
        checkedAt: new Date().toISOString(),
        cached: false,
      };
    }
    if (now() - cache.at < OCR_PROBE_TTL_MS && cache.result) return { ...cache.result, cached: true };
    if (cache.inflight) return { ...(await cache.inflight), cached: true };

    cache.inflight = runProbe();
    try {
      const result = await cache.inflight;
      cache = { at: Date.now(), result, inflight: null };
      return { ...result, cached: false };
    } catch {
      cache = {
        at: Date.now(),
        result: {
          reachable: false,
          configured: false,
          ready: false,
          simMode: null,
          model: null,
          latencyMs: null,
          upstreamTimeoutMs: null,
          checkedAt: new Date().toISOString(),
        },
        inflight: null,
      };
      return { ...cache.result, cached: false };
    }
  }

  return {
    probeOcr,
    resetCache() {
      cache = { at: 0, result: null, inflight: null };
    },

    /* Gọi lúc khởi động (index.js): nếu cấu hình vi phạm chuỗi timeout giảm dần (R2) thì
     * ghi log warn kèm đúng các giá trị đang dùng, để người vận hành sửa được ngay. */
    async checkTimeoutChain() {
      const probe = await probeOcr();
      /* Lúc khởi động ai-server có thể chưa kịp lên. Không để kết quả probe hỏng của lần
       * kiểm cấu hình này nằm lại trong cache 10 s và làm /api/status báo OCR chết oan. */
      if (!probe.reachable) cache = { at: 0, result: null, inflight: null };
      const result = checkTimeoutChain({
        recognitionTimeoutMs: config.recognitionTimeoutMs,
        upstreamTimeoutMs: probe.upstreamTimeoutMs ?? null,
      });
      if (!result.ok) {
        logger?.warn("config.timeout_chain_invalid", {
          problems: result.problems,
          webappTimeoutMs: result.webappTimeoutMs,
          recognitionTimeoutMs: result.recognitionTimeoutMs,
          upstreamTimeoutMs: result.upstreamTimeoutMs,
          expected: "webapp > RECOGNITION_TIMEOUT_MS > UPSTREAM_TIMEOUT_MS",
        });
      }
      return result;
    },

    async build({ deviceId = null } = {}) {
      const effective = sim.effective({ deviceId });
      const enabled = sim.enabled;
      /* §5.1: khi SIM_OVERRIDE=false thì sim.effective BÁO CÁO ra ngoài là mặc định thuần.
       * sim.effective() vẫn trả kịch bản hành vi (gồm MOCK_MODE — bậc thang Q7 của §6.3),
       * nhưng MOCK_MODE là cấu hình của provider mock, không phải kịch bản mô phỏng: báo nó
       * ra /api/status khi mô phỏng đã tắt là nói sai về thứ PDA đang nhìn. */
      const reported = enabled ? effective : structuredClone(SIM_DEFAULT);
      const state = enabled ? (BACKEND_STATE[effective.backend.mode] ?? "up") : "up";
      const latencyMs = state === "degraded" ? effective.backend.latencyMs : 0;
      const ocr = await probeOcr();
      const queue = recognition.stats();
      const sapAdapter = config.sap?.adapter ?? "none";
      const sapScenario = enabled ? sim.effective({ deviceId: null }).sap : structuredClone(SIM_DEFAULT).sap;

      return {
        backend: {
          state,
          readonly: state === "readonly",
          latencyMs,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          simulated: state !== "up" || latencyMs > 0,
        },
        ocr: {
          reachable: ocr.reachable,
          configured: ocr.configured,
          // R7: `ready` = phục vụ được /recognize (có key HOẶC đang chạy sim) — FE bật đèn theo trường này.
          ready: ocr.ready,
          simMode: ocr.simMode,
          mode: reported.ocr.mode,
          model: ocr.model,
          provider: config.provider,
          checkedAt: ocr.checkedAt,
          latencyMs: ocr.latencyMs,
          cached: ocr.cached,
        },
        /* Phase 4 đảo ngược §5.1 của Phase 3 một cách CÓ CHỦ Ý: adapter SAP đã tồn tại và mock
         * chính là adapter đang chạy, nên mode ở đây phản ánh đúng chế độ của nó. Đọc kịch bản
         * TOÀN CỤC vì SAP mock chỉ nghe phạm vi toàn cục (L9) — kịch bản riêng của một thiết bị
         * không đổi được hành vi của hệ ở đầu kia. Đúng 2 key, không thêm key nào (O2). */
        sap: {
          reachable: sapAdapter !== "none" && sapScenario.mode !== "down",
          mode: sapAdapter === "none" ? "not_configured" : sapScenario.mode,
        },
        queue: {
          recognitionsInflight: queue.inflight,
          recognitionsWaiting: queue.waiting,
          outboxPending: outbox ? outbox.pendingCount() : 0,
          /* Phase 5: hai con số người giám sát cần khi chạy RECOGNITION_MODE=async. */
          recognitionsPending: recognition.pendingCount(),
          recognitionsFailedRecent: recognition.failedRecentCount(),
        },
        /* Khoá cấp một MỚI của Phase 5, chèn ngay sau `queue`. Đúng 5 khoá, tất cả đọc từ
         * config, không đọc DB. FE-1 dùng `mode` để tự biết đi đường sync hay async mà không
         * cần biến build-time (QUYẾT ĐỊNH A-6). */
        recognition: {
          mode: config.recognitionMode,
          maxConcurrent: config.recognitionMaxConcurrent,
          maxWaiting: config.recognitionMaxWaiting,
          timeoutMs: config.recognitionTimeoutMs,
          pollHintMs: config.recognitionPollHintMs,
        },
        sim: {
          enabled,
          scope: enabled ? sim.scopeFor(deviceId) : "none",
          effective: reported,
          global: enabled ? sim.getGlobal() : null,
          device: enabled ? sim.getDeviceRaw(deviceId) : null,
          updatedAt: enabled ? sim.updatedAtFor(deviceId) : null,
        },
        serverTime: new Date().toISOString(),
        version,
      };
    },
  };
}
