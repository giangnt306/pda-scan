import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, getJson, putJson, upload, waitFor, recordingLogger, JPEG, DEVICE_A, DEVICE_B } from "./helpers.js";
import { checkTimeoutChain, WEBAPP_RECOGNITION_TIMEOUT_MS } from "../src/status.js";
import { SIM_DEFAULT } from "../src/sim/engine.js";

/* fetch giả cho probe GET /health của ai-server: đếm số lần gọi thật để kiểm cache TTL. */
function fakeProbe({ ok = true, body = { ok: true, configured: true, model: "gpt-4o-mini" }, fail = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (fail) throw new TypeError("fetch failed");
    return { ok, status: ok ? 200 : 503, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const httpConfig = { provider: "http", ai: { url: "http://ai.local/recognize" } };

test("GET /api/status: đủ mọi key của hợp đồng, sap luôn not_configured, outboxPending = 0", async () => {
  const t = await startTestApp();
  try {
    const { status, body } = await getJson(t.base, "/api/status", { "x-device-id": DEVICE_A });
    assert.equal(status, 200);

    assert.deepEqual(Object.keys(body.backend).sort(), ["latencyMs", "readonly", "simulated", "state", "uptimeSec"]);
    assert.equal(body.backend.state, "up");
    assert.equal(body.backend.readonly, false);
    assert.equal(body.backend.latencyMs, 0);
    assert.equal(typeof body.backend.uptimeSec, "number");
    assert.equal(body.backend.simulated, false);

    // ready + simMode là bắt buộc theo ĐÍNH CHÍNH R7 (đèn OCR của PDA đọc `ready`).
    assert.deepEqual(Object.keys(body.ocr).sort(), [
      "cached",
      "checkedAt",
      "configured",
      "latencyMs",
      "mode",
      "model",
      "provider",
      "reachable",
      "ready",
      "simMode",
    ]);
    assert.deepEqual(body.sap, { reachable: false, mode: "not_configured" });
    /* Phase 5 thêm đúng 2 khoá (02-contracts-api.md §2.1); vẫn deepEqual để khoá lạ thứ sáu
     * làm test đỏ. Khối `recognition` cấp một có test riêng ngay dưới. */
    assert.deepEqual(body.queue, {
      recognitionsInflight: 0,
      recognitionsWaiting: 0,
      outboxPending: 0,
      recognitionsPending: 0,
      recognitionsFailedRecent: 0,
    });

    assert.equal(body.sim.enabled, true);
    assert.equal(body.sim.scope, "none");
    assert.deepEqual(body.sim.effective, {
      backend: { mode: "normal", latencyMs: 0 },
      ocr: { mode: "success", delayMs: 0 },
      save: { mode: "normal", latencyMs: 0 },
      sap: { mode: "success", latencyMs: 0 },
    });
    assert.deepEqual(body.sim.global, body.sim.effective);
    assert.equal(body.sim.device, null);
    assert.equal(body.sim.updatedAt, null);
    assert.match(body.serverTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(body.version, "0.1.0");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("status.ocr với provider mock: reachable=true, configured=true, ready=true, simMode=null, model=mock-vlm-0, cached=false", async () => {
  const t = await startTestApp();
  try {
    const { body } = await getJson(t.base, "/api/status");
    assert.equal(body.ocr.provider, "mock");
    assert.equal(body.ocr.reachable, true);
    assert.equal(body.ocr.configured, true);
    assert.equal(body.ocr.ready, true, "provider mock luôn phục vụ được");
    assert.equal(body.ocr.simMode, null);
    assert.equal(body.ocr.model, "mock-vlm-0");
    assert.equal(body.ocr.cached, false);
    assert.equal(body.ocr.latencyMs, 0);
    assert.equal(body.ocr.mode, "success");
    assert.ok(body.ocr.checkedAt);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("status.ocr với provider http: probe /health thành công → reachable=true kèm model; probe hỏng → reachable=false, không ném lỗi", async () => {
  const good = fakeProbe();
  const t = await startTestApp(httpConfig, { probeFetch: good });
  try {
    const { body } = await getJson(t.base, "/api/status");
    assert.equal(good.calls.length, 1);
    assert.equal(good.calls[0].url, "http://ai.local/health", "probe dùng /health, không phải /recognize");
    assert.equal(body.ocr.reachable, true);
    assert.equal(body.ocr.configured, true);
    assert.equal(body.ocr.model, "gpt-4o-mini");
    assert.equal(typeof body.ocr.latencyMs, "number");
  } finally {
    await t.stop();
    t.cleanup();
  }

  const bad = await startTestApp(httpConfig, { probeFetch: fakeProbe({ fail: true }) });
  try {
    const { status, body } = await getJson(bad.base, "/api/status");
    assert.equal(status, 200, "probe hỏng không được làm hỏng /api/status");
    assert.equal(body.ocr.reachable, false);
    assert.equal(body.ocr.configured, false);
    assert.equal(body.ocr.ready, false, "không hỏi được /health thì không dám báo sẵn sàng");
    assert.equal(body.ocr.simMode, null);
    assert.equal(body.ocr.model, null);
    assert.equal(body.ocr.latencyMs, null);
  } finally {
    await bad.stop();
    bad.cleanup();
  }
});

test("status.ocr lấy ready/simMode từ /health; simMode khác passthrough → model = sim-<mode> (ĐÍNH CHÍNH R7)", async () => {
  // Cấu hình demo: KHÔNG có OPENAI_API_KEY nhưng ai-server vẫn phục vụ bằng dữ liệu giả lập.
  const sim = await startTestApp(httpConfig, {
    probeFetch: fakeProbe({ body: { ok: true, configured: false, ready: true, simMode: "garbage", model: "gpt-4o-mini" } }),
  });
  try {
    const { body } = await getJson(sim.base, "/api/status");
    assert.equal(body.ocr.reachable, true);
    assert.equal(body.ocr.configured, false, "configured chỉ nói về OPENAI_API_KEY");
    assert.equal(body.ocr.ready, true, "đang mô phỏng vẫn phục vụ được → đèn OCR không được đỏ");
    assert.equal(body.ocr.simMode, "garbage");
    assert.equal(body.ocr.model, "sim-garbage", "không được khai tên model LLM khi kết quả do sim sinh ra");
  } finally {
    await sim.stop();
    sim.cleanup();
  }

  // passthrough = gọi LLM thật: giữ nguyên tên model và ready theo configured.
  const real = await startTestApp(httpConfig, {
    probeFetch: fakeProbe({ body: { ok: true, configured: true, ready: true, simMode: "passthrough", model: "gpt-4o-mini" } }),
  });
  try {
    const { body } = await getJson(real.base, "/api/status");
    assert.equal(body.ocr.simMode, "passthrough");
    assert.equal(body.ocr.model, "gpt-4o-mini");
    assert.equal(body.ocr.ready, true);
  } finally {
    await real.stop();
    real.cleanup();
  }

  // ai-server bản cũ chưa có ready/simMode: suy ra ready = configured, không đoán thêm.
  const legacy = await startTestApp(httpConfig, { probeFetch: fakeProbe({ body: { ok: true, configured: true, model: "gpt-4o-mini" } }) });
  try {
    const { body } = await getJson(legacy.base, "/api/status");
    assert.equal(body.ocr.ready, true);
    assert.equal(body.ocr.simMode, null);
    assert.equal(body.ocr.model, "gpt-4o-mini");
  } finally {
    await legacy.stop();
    legacy.cleanup();
  }

  const legacyNoKey = await startTestApp(httpConfig, { probeFetch: fakeProbe({ body: { ok: true, configured: false, model: null } }) });
  try {
    const { body } = await getJson(legacyNoKey.base, "/api/status");
    assert.equal(body.ocr.ready, false, "bản cũ không có ready → suy ra từ configured");
    assert.equal(body.ocr.simMode, null);
  } finally {
    await legacyNoKey.stop();
    legacyNoKey.cleanup();
  }
});

test("checkTimeoutChain: webapp > BE > ai-server là hợp lệ; bằng nhau hoặc ngược thứ tự là vi phạm; thiếu upstreamTimeoutMs thì bỏ qua vế trong", () => {
  assert.equal(WEBAPP_RECOGNITION_TIMEOUT_MS, 60000);
  assert.deepEqual(checkTimeoutChain({ recognitionTimeoutMs: 20000, upstreamTimeoutMs: 18000 }).problems, []);
  assert.equal(checkTimeoutChain({ recognitionTimeoutMs: 20000, upstreamTimeoutMs: 18000 }).ok, true);

  // Hai tầng bằng nhau: tầng ngoài vẫn có thể hết hạn trước tầng trong → phải báo vi phạm.
  assert.deepEqual(checkTimeoutChain({ recognitionTimeoutMs: 20000, upstreamTimeoutMs: 20000 }).problems, ["backend_le_upstream"]);
  assert.deepEqual(checkTimeoutChain({ recognitionTimeoutMs: 20000, upstreamTimeoutMs: 25000 }).problems, ["backend_le_upstream"]);
  assert.deepEqual(checkTimeoutChain({ recognitionTimeoutMs: 60000, upstreamTimeoutMs: 18000 }).problems, ["webapp_le_backend"]);
  assert.deepEqual(checkTimeoutChain({ recognitionTimeoutMs: 90000, upstreamTimeoutMs: 95000 }).problems, ["webapp_le_backend", "backend_le_upstream"]);

  // ai-server bản cũ không khai báo → không đoán, chỉ kiểm vế ngoài.
  assert.equal(checkTimeoutChain({ recognitionTimeoutMs: 20000 }).ok, true);
  assert.equal(checkTimeoutChain({ recognitionTimeoutMs: 20000 }).upstreamTimeoutMs, null);
});

test("khởi động: UPSTREAM_TIMEOUT_MS ≥ RECOGNITION_TIMEOUT_MS → log warn config.timeout_chain_invalid kèm cả 3 giá trị", async () => {
  const logger = recordingLogger();
  const t = await startTestApp(
    { ...httpConfig, recognitionTimeoutMs: 20000 },
    { logger, probeFetch: fakeProbe({ body: { ok: true, configured: true, ready: true, simMode: "passthrough", model: "m", upstreamTimeoutMs: 20000 } }) },
  );
  try {
    const result = await t.app.status.checkTimeoutChain();
    assert.equal(result.ok, false);
    const warns = logger.find("config.timeout_chain_invalid");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].level, "warn");
    assert.deepEqual(warns[0].problems, ["backend_le_upstream"]);
    assert.equal(warns[0].webappTimeoutMs, 60000);
    assert.equal(warns[0].recognitionTimeoutMs, 20000);
    assert.equal(warns[0].upstreamTimeoutMs, 20000);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("khởi động: chuỗi timeout hợp lệ (20000 > 18000) → KHÔNG log warn; ai-server không khai upstreamTimeoutMs cũng không log", async () => {
  const good = recordingLogger();
  const t = await startTestApp(
    { ...httpConfig, recognitionTimeoutMs: 20000 },
    { logger: good, probeFetch: fakeProbe({ body: { ok: true, configured: true, ready: true, simMode: "passthrough", model: "m", upstreamTimeoutMs: 18000 } }) },
  );
  try {
    assert.equal((await t.app.status.checkTimeoutChain()).ok, true);
    assert.deepEqual(good.find("config.timeout_chain_invalid"), []);
  } finally {
    await t.stop();
    t.cleanup();
  }

  const silentOld = recordingLogger();
  const legacy = await startTestApp(
    { ...httpConfig, recognitionTimeoutMs: 20000 },
    { logger: silentOld, probeFetch: fakeProbe({ body: { ok: true, configured: true, model: "m" } }) },
  );
  try {
    const result = await legacy.app.status.checkTimeoutChain();
    assert.equal(result.ok, true, "thiếu thông tin thì không đoán, không cảnh báo");
    assert.equal(result.upstreamTimeoutMs, null);
    assert.deepEqual(silentOld.find("config.timeout_chain_invalid"), []);
  } finally {
    await legacy.stop();
    legacy.cleanup();
  }
});

test("SIM_OVERRIDE=false + MOCK_MODE=timeout: status.sim.effective và status.ocr.mode là mặc định, nhưng MOCK_MODE vẫn áp cho provider", async () => {
  const t = await startTestApp({ simOverride: false, mock: { mode: "timeout", delayMs: 0, slowDelayMs: 0 }, recognitionTimeoutMs: 80 });
  try {
    const { status, body } = await getJson(t.base, "/api/status");
    assert.equal(status, 200);
    assert.equal(body.sim.enabled, false);
    // §5.1: mô phỏng tắt thì effective báo ra là MẶC ĐỊNH, không phản chiếu MOCK_MODE.
    assert.deepEqual(body.sim.effective, SIM_DEFAULT);
    assert.equal(body.ocr.mode, "success");
    assert.equal(body.backend.state, "up");

    // Nhưng MOCK_MODE vẫn là cấu hình thật của provider (bậc thang Q7 §6.3): hành vi không đổi.
    const rec = await upload(t.base, JPEG);
    assert.equal(rec.status, 504, "MOCK_MODE=timeout vẫn có tác dụng khi SIM_OVERRIDE=false");
    assert.equal(rec.body.error.code, "RECOGNITION_TIMEOUT");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("/api/status KHÔNG từ chối vì x-device-id hỏng: vẫn 200, bỏ qua device, không áp kịch bản theo device", async () => {
  const t = await startTestApp();
  try {
    // Device A có kịch bản riêng; request mang header hỏng phải rơi về kịch bản global.
    await putJson(t.base, "/api/admin/sim", { ocr: { delayMs: 300 } });
    await putJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`, { ocr: { mode: "error" } });

    for (const junk of ["NOT-A-UUID", DEVICE_A.toUpperCase(), "00000000-0000-1000-0000-000000000000", "   "]) {
      const r = await getJson(t.base, "/api/status", { "x-device-id": junk });
      assert.equal(r.status, 200, `x-device-id="${junk}" không được chặn đường sống của PDA`);
      assert.equal(r.body.sim.scope, "global", "header hỏng = coi như không có device");
      assert.equal(r.body.sim.device, null);
      assert.equal(r.body.ocr.mode, "success");
    }

    // Endpoint khác vẫn phải từ chối header hỏng như cũ (§10.2).
    const biz = await getJson(t.base, "/api/receipts", { "x-device-id": "NOT-A-UUID" });
    assert.equal(biz.status, 400);
    assert.equal(biz.body.error.code, "INVALID_DEVICE_ID");

    // Header đúng thì /api/status vẫn áp kịch bản của device như trước.
    const okHeader = await getJson(t.base, "/api/status", { "x-device-id": DEVICE_A });
    assert.equal(okHeader.body.sim.scope, "device");
    assert.equal(okHeader.body.ocr.mode, "error");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("cache probe 10 s: 3 lần gọi status liên tiếp chỉ probe 1 lần (đếm fetch giả)", async () => {
  const probe = fakeProbe();
  const t = await startTestApp(httpConfig, { probeFetch: probe });
  try {
    const first = await getJson(t.base, "/api/status");
    const second = await getJson(t.base, "/api/status");
    const third = await getJson(t.base, "/api/status");
    assert.equal(probe.calls.length, 1, "TTL 10 s: chỉ probe một lần");
    assert.equal(first.body.ocr.cached, false);
    assert.equal(second.body.ocr.cached, true);
    assert.equal(third.body.ocr.cached, true);
    assert.equal(second.body.ocr.checkedAt, first.body.ocr.checkedAt);

    // Song song cũng không probe thêm: request trùng nhịp dồn vào một promise.
    t.app.status.resetCache();
    await Promise.all([getJson(t.base, "/api/status"), getJson(t.base, "/api/status"), getJson(t.base, "/api/status")]);
    assert.equal(probe.calls.length, 2);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("status phản chiếu sim: PUT backend.mode=degraded latencyMs=1200 → backend.state=degraded, latencyMs=1200, simulated=true", async () => {
  const t = await startTestApp();
  try {
    const put = await putJson(t.base, "/api/admin/sim", { backend: { mode: "degraded", latencyMs: 1200 } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.global.backend, { mode: "degraded", latencyMs: 1200 });

    const t0 = Date.now();
    const { body } = await getJson(t.base, "/api/status");
    assert.ok(Date.now() - t0 >= 1200, "/api/status vẫn chịu latency của degraded (Q9)");
    assert.equal(body.backend.state, "degraded");
    assert.equal(body.backend.readonly, false);
    assert.equal(body.backend.latencyMs, 1200);
    assert.equal(body.backend.simulated, true);
    assert.equal(body.sim.scope, "global");
    assert.ok(body.sim.updatedAt);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("status.sim.scope = device khi request có x-device-id đã đặt kịch bản riêng; = global khi không", async () => {
  const t = await startTestApp();
  try {
    await putJson(t.base, "/api/admin/sim", { ocr: { delayMs: 300 } });
    await putJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`, { ocr: { mode: "error" } });

    const withDevice = await getJson(t.base, "/api/status", { "x-device-id": DEVICE_A });
    assert.equal(withDevice.body.sim.scope, "device");
    assert.deepEqual(withDevice.body.sim.device, { ocr: { mode: "error" } });
    assert.equal(withDevice.body.sim.effective.ocr.mode, "error");
    assert.equal(withDevice.body.sim.effective.ocr.delayMs, 300, "trộn theo từng field: delayMs của global còn nguyên");
    assert.equal(withDevice.body.ocr.mode, "error");

    const otherDevice = await getJson(t.base, "/api/status", { "x-device-id": DEVICE_B });
    assert.equal(otherDevice.body.sim.scope, "global");
    assert.equal(otherDevice.body.sim.device, null);
    assert.equal(otherDevice.body.sim.effective.ocr.mode, "success");

    const noDevice = await getJson(t.base, "/api/status");
    assert.equal(noDevice.body.sim.scope, "global");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

/* ═══════════════════ Phase 5 — nhận dạng bất đồng bộ trên /api/status ═══════════════════ */

test("GET /api/status có queue.recognitionsPending, queue.recognitionsFailedRecent và khối recognition đủ 5 khoá", async () => {
  /* Bốn giá trị KHÁC NHAU (async / 4 / 7 / 2500 / 1500) để một khoá bị nối nhầm sang khoá khác
   * là lộ ra ngay — nếu cả năm đều bằng nhau thì đảo chỗ chúng vẫn xanh. */
  const t = await startTestApp({
    recognitionMode: "async",
    recognitionMaxConcurrent: 4,
    recognitionMaxWaiting: 7,
    recognitionTimeoutMs: 2500,
    recognitionPollHintMs: 1500,
  });
  try {
    const idle = await getJson(t.base, "/api/status");
    assert.equal(idle.status, 200);
    assert.equal(idle.body.queue.recognitionsPending, 0);
    assert.equal(idle.body.queue.recognitionsFailedRecent, 0);
    assert.deepEqual(Object.keys(idle.body.recognition).sort(), [
      "maxConcurrent",
      "maxWaiting",
      "mode",
      "pollHintMs",
      "timeoutMs",
    ]);
    assert.equal(idle.body.recognition.mode, "async");
    assert.equal(idle.body.recognition.maxConcurrent, 4);
    assert.equal(idle.body.recognition.maxWaiting, 7);
    assert.equal(idle.body.recognition.timeoutMs, 2500);
    assert.equal(idle.body.recognition.pollHintMs, 1500);

    // Một job treo → recognitionsPending = 1; hết ngân sách → failed → recognitionsFailedRecent = 1.
    await upload(t.base, JPEG, { query: "?sim=timeout" });
    const busy = await getJson(t.base, "/api/status");
    assert.equal(busy.body.queue.recognitionsPending, 1, "job nền đang chạy phải hiện ở recognitionsPending");
    assert.equal(busy.body.queue.recognitionsFailedRecent, 0);

    const failed = await waitFor(
      async () => {
        const s = await getJson(t.base, "/api/status");
        return s.body.queue.recognitionsFailedRecent === 1 ? s.body.queue : null;
      },
      { timeoutMs: 8000, label: "job hết ngân sách và chuyển sang failed" },
    );
    assert.equal(failed.recognitionsPending, 0);
    assert.equal(failed.recognitionsFailedRecent, 1, "cửa sổ 5 phút phải đếm được lần hỏng vừa xảy ra");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/status.sap vẫn đúng 2 khoá reachable và mode sau khi thêm khối recognition", async () => {
  const t = await startTestApp({ sap: { adapter: "mock" } });
  try {
    const body = (await getJson(t.base, "/api/status")).body;
    /* Phase 4 §8.1 chốt "đúng 2 key, không thêm key nào". Khối `recognition` là khoá CẤP MỘT
     * mới, KHÔNG được lẫn vào trong sap. */
    assert.deepEqual(Object.keys(body.sap).sort(), ["mode", "reachable"]);
    assert.equal(body.sap.reachable, true);
    assert.equal(body.sap.mode, "success");
    assert.equal(Object.hasOwn(body.sap, "recognition"), false);
    assert.ok(Object.hasOwn(body, "recognition"), "recognition phải nằm ở CẤP MỘT");

    // 6 nhóm khoá cấp một của hợp đồng + đúng MỘT khoá cấp một mới (B5).
    assert.deepEqual(Object.keys(body).sort(), [
      "backend",
      "ocr",
      "queue",
      "recognition",
      "sap",
      "serverTime",
      "sim",
      "version",
    ]);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
