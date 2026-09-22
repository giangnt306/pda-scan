import { test } from "node:test";
import assert from "node:assert/strict";
import { createSapMock } from "../src/sap/mock.js";
import { SapBusinessError, SapTechnicalError, selectSapAdapter } from "../src/sap/adapter.js";
import { startTestApp, getJson } from "./helpers.js";

/* sim giả: mock SAP chỉ đọc sim.effective({deviceId:null}).sap, nên test không cần dựng cả app. */
const fakeSim = (sap) => ({ effective: () => ({ sap: { mode: "success", latencyMs: 0, ...sap } }) });

const cfg = (sap = {}) => ({ sap: { timeoutMs: 15000, maxAttempts: 5, mockSuccessDelayMs: 0, mockSlowDelayMs: 1000, ...sap } });

const payload = (receiptId) => ({
  receiptId,
  createdAt: "2026-09-21T14:10:00.000Z",
  deviceId: null,
  sessionId: null,
  warehouse: "Kho Long Biên",
  operator: "NV-01",
  data: { partNumber: "BEX32181030AB", quantity: 80 },
});

test("mock success: gửi 2 lần cùng receiptId → trả CÙNG sapDocumentNo (idempotency)", async () => {
  const sap = createSapMock({ config: cfg(), sim: fakeSim({ mode: "success" }) });
  const first = await sap.postGoodsReceipt(payload("r-1"));
  const second = await sap.postGoodsReceipt(payload("r-1"));
  const other = await sap.postGoodsReceipt(payload("r-2"));

  assert.match(first.sapDocumentNo, /^5000\d{6}$/);
  assert.equal(second.sapDocumentNo, first.sapDocumentNo, "cùng receiptId phải cho cùng số chứng từ");
  assert.notEqual(other.sapDocumentNo, first.sapDocumentNo, "receiptId khác phải cho số chứng từ khác");
  assert.ok(typeof first.postedAt === "string" && first.postedAt.endsWith("Z"));
});

test("mock down: ném SapTechnicalError code SAP_UNAVAILABLE, retryable = true", async () => {
  const sap = createSapMock({ config: cfg(), sim: fakeSim({ mode: "down" }) });
  await assert.rejects(
    () => sap.postGoodsReceipt(payload("r-down")),
    (err) => {
      assert.ok(err instanceof SapTechnicalError, "lỗi hạ tầng phải là SapTechnicalError");
      assert.equal(err.code, "SAP_UNAVAILABLE");
      assert.equal(err.retryable, true);
      assert.equal(err.status, null);
      return true;
    },
  );
});

test("mock reject: ném SapBusinessError code SAP_PART_UNKNOWN, retryable = false, có sapMessage", async () => {
  const sap = createSapMock({ config: cfg(), sim: fakeSim({ mode: "reject" }) });
  await assert.rejects(
    () => sap.postGoodsReceipt(payload("r-reject")),
    (err) => {
      assert.ok(err instanceof SapBusinessError, "lỗi nghiệp vụ phải là SapBusinessError");
      assert.equal(err.code, "SAP_PART_UNKNOWN");
      assert.equal(err.retryable, false);
      assert.equal(err.sapMessage, "Material BEX32181030AB does not exist in plant 1000");
      return true;
    },
  );
});

test("mock slow với SAP_TIMEOUT_MS=200 → ném SapTechnicalError code SAP_TIMEOUT", async () => {
  const config = cfg({ timeoutMs: 200, mockSlowDelayMs: 3000 });
  const sap = createSapMock({ config, sim: fakeSim({ mode: "slow" }) });
  const startedAt = Date.now();
  await assert.rejects(
    () => sap.postGoodsReceipt(payload("r-slow"), { signal: AbortSignal.timeout(config.sap.timeoutMs) }),
    (err) => {
      assert.ok(err instanceof SapTechnicalError);
      assert.equal(err.code, "SAP_TIMEOUT");
      assert.equal(err.retryable, true);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1500, `phải bỏ cuộc khi signal bắn (~200 ms), thực tế chờ ${elapsed} ms`);
});

test("sap.latencyMs của kịch bản cộng thêm vào mọi mode trừ down", async () => {
  const LAT = 150;

  const okStart = Date.now();
  await createSapMock({ config: cfg(), sim: fakeSim({ mode: "success", latencyMs: LAT }) }).postGoodsReceipt(payload("r-lat-ok"));
  const okElapsed = Date.now() - okStart;
  assert.ok(okElapsed >= LAT - 20, `mode success phải chờ ít nhất ${LAT} ms, thực tế ${okElapsed} ms`);

  const rejStart = Date.now();
  await assert.rejects(() =>
    createSapMock({ config: cfg(), sim: fakeSim({ mode: "reject", latencyMs: LAT }) }).postGoodsReceipt(payload("r-lat-rej")),
  );
  const rejElapsed = Date.now() - rejStart;
  assert.ok(rejElapsed >= 300 + LAT - 20, `mode reject phải chờ 300 + ${LAT} ms, thực tế ${rejElapsed} ms`);

  // down ném NGAY, không chờ — kể cả khi kịch bản đặt độ trễ rất lớn.
  const downStart = Date.now();
  await assert.rejects(() =>
    createSapMock({ config: cfg(), sim: fakeSim({ mode: "down", latencyMs: 5000 }) }).postGoodsReceipt(payload("r-lat-down")),
  );
  const downElapsed = Date.now() - downStart;
  assert.ok(downElapsed < 200, `mode down không được chờ latencyMs, thực tế ${downElapsed} ms`);
});

test('GET /api/status: adapter=none → sap đúng 2 key {reachable:false, mode:"not_configured"}; adapter=mock + sim down → {reachable:false, mode:"down"}', async () => {
  const none = await startTestApp();
  try {
    const body = (await getJson(none.base, "/api/status")).body;
    assert.deepEqual(Object.keys(body.sap), ["reachable", "mode"], "status.sap phải đúng 2 key, không thêm key nào");
    assert.deepEqual(body.sap, { reachable: false, mode: "not_configured" });
    assert.equal(selectSapAdapter({ config: none.config, sim: none.app.sim }), null, 'adapter "none" phải trả null');
  } finally {
    await none.stop();
    none.cleanup();
  }

  const mock = await startTestApp({ sap: { adapter: "mock" }, outbox: { enabled: false } });
  try {
    const up = (await getJson(mock.base, "/api/status")).body;
    assert.deepEqual(up.sap, { reachable: true, mode: "success" });

    mock.app.sim.setGlobal({ sap: { mode: "down" } });
    const down = (await getJson(mock.base, "/api/status")).body;
    assert.deepEqual(Object.keys(down.sap), ["reachable", "mode"]);
    assert.deepEqual(down.sap, { reachable: false, mode: "down" });

    mock.app.sim.setGlobal({ sap: { mode: "reject" } });
    assert.deepEqual((await getJson(mock.base, "/api/status")).body.sap, { reachable: true, mode: "reject" });
  } finally {
    await mock.stop();
    mock.cleanup();
  }
});
