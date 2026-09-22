import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  startSapApp,
  postJson,
  getJson,
  receiptBody,
  validData,
  tempDataDir,
  recordingLogger,
  waitFor,
  DEVICE_A,
} from "./helpers.js";

const outboxRows = (t, receiptId) =>
  t.app.db.prepare("SELECT * FROM outbox WHERE receipt_id = ? ORDER BY id").all(receiptId);

const statusOf = async (base, id) => (await getJson(base, `/api/receipts/${id}`)).body.status;

/* App có adapter mock nhưng worker TẮT: job được tạo thật, nhưng không ai xử lý — nhờ vậy
 * khẳng định được về dòng outbox vừa sinh mà không phải đua với worker. */
const startQueueOnlyApp = (overrides = {}) =>
  startTestApp({ sap: { adapter: "mock" }, outbox: { enabled: false, tickMs: 20 }, ...overrides });

test("POST /api/receipts với SAP_ADAPTER=mock → tạo đúng 1 dòng outbox kind='post' state='pending', response status='confirmed'", async () => {
  const t = await startQueueOnlyApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-enq-0001"));
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "confirmed");

    const rows = outboxRows(t, created.body.receiptId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "post");
    assert.equal(rows[0].state, "pending");
    assert.equal(rows[0].attempts, 0);
    assert.equal(rows[0].last_error, null);

    const status = await getJson(t.base, "/api/status");
    assert.equal(status.body.queue.outboxPending, 1);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("POST /api/receipts với SAP_ADAPTER=none → KHÔNG tạo dòng outbox, status vẫn 'confirmed', queue.outboxPending = 0", async () => {
  const t = await startTestApp(); // mặc định của startTestApp là adapter "none"
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-none-0001"));
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "confirmed");
    assert.equal(outboxRows(t, created.body.receiptId).length, 0);

    const status = await getJson(t.base, "/api/status");
    assert.equal(status.body.queue.outboxPending, 0);
    assert.deepEqual(status.body.sap, { reachable: false, mode: "not_configured" });
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("worker mode success: phiếu chuyển confirmed → posting → posted, có sapDocumentNo, dòng outbox bị xoá", async () => {
  const t = await startSapApp({ sap: { adapter: "mock", mockSuccessDelayMs: 0 } });
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-ok-000001"));
    const id = created.body.receiptId;
    assert.equal(created.body.status, "confirmed");

    const posted = await waitFor(
      async () => {
        const r = await getJson(t.base, `/api/receipts/${id}`);
        return r.body.status === "posted" ? r.body : null;
      },
      { label: "phiếu chuyển sang posted" },
    );

    assert.match(posted.sapDocumentNo, /^5000\d{6}$/);
    assert.equal(posted.postAttempts, 1);
    assert.equal(posted.rejectCode, null);
    assert.equal(outboxRows(t, id).length, 0, "job đã gửi xong phải bị xoá khỏi outbox");

    const events = (await getJson(t.base, `/api/receipts/${id}/events`)).body.items;
    assert.deepEqual(
      events.map((e) => e.event),
      ["receipt.confirmed", "receipt.posting", "receipt.posted"],
    );
    assert.deepEqual(
      events.map((e) => [e.from, e.to]),
      [
        [null, "confirmed"],
        ["confirmed", "posting"],
        ["posting", "posted"],
      ],
    );
    assert.equal(events[2].detail.sapDocumentNo, posted.sapDocumentNo);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("worker mode down: attempts tăng 1..5 theo backoff, sau lần 5 → post_failed, outbox.state='failed'", async () => {
  const t = await startSapApp({ outbox: { enabled: true, tickMs: 20, backoffsMs: [5, 5, 5, 5] } });
  try {
    t.app.sim.setGlobal({ sap: { mode: "down" } });
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-down-0001"));
    const id = created.body.receiptId;

    const failed = await waitFor(
      async () => {
        const r = await getJson(t.base, `/api/receipts/${id}`);
        return r.body.status === "post_failed" ? r.body : null;
      },
      { timeoutMs: 8000, label: "phiếu chuyển sang post_failed" },
    );

    assert.equal(failed.postAttempts, 5, "phải gọi đủ SAP_MAX_ATTEMPTS = 5 lần");
    assert.equal(failed.sapDocumentNo, null);

    const rows = outboxRows(t, id);
    assert.equal(rows.length, 1, "job post_failed được GIỮ LẠI để retry-post dùng");
    assert.equal(rows[0].state, "failed");
    assert.equal(rows[0].attempts, 5);
    assert.equal(rows[0].last_error, "SAP_UNAVAILABLE");

    const events = (await getJson(t.base, `/api/receipts/${id}/events`)).body.items;
    const retries = events.filter((e) => e.event === "receipt.post_retry");
    assert.deepEqual(
      retries.map((e) => e.detail.attempt),
      [1, 2, 3, 4],
      "chỉ retry sau 4 lần đầu, lần thứ 5 là bỏ cuộc",
    );
    for (const r of retries) {
      assert.equal(r.detail.code, "SAP_UNAVAILABLE");
      assert.equal(r.detail.delayMs, 5);
      assert.ok(typeof r.detail.nextAttemptAt === "string");
    }
    const last = events.at(-1);
    assert.equal(last.event, "receipt.post_failed");
    assert.equal(last.detail.attempt, 5);
    assert.equal(last.to, "post_failed");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("worker mode reject: → rejected ngay ở lần 1, KHÔNG retry, rejectCode='SAP_PART_UNKNOWN', outbox bị xoá", async () => {
  const t = await startSapApp({ outbox: { enabled: true, tickMs: 20, backoffsMs: [5, 5, 5, 5] } });
  try {
    t.app.sim.setGlobal({ sap: { mode: "reject", latencyMs: 0 } });
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-rej-00001"));
    const id = created.body.receiptId;

    const rejected = await waitFor(
      async () => {
        const r = await getJson(t.base, `/api/receipts/${id}`);
        return r.body.status === "rejected" ? r.body : null;
      },
      { timeoutMs: 8000, label: "phiếu chuyển sang rejected" },
    );

    assert.equal(rejected.rejectCode, "SAP_PART_UNKNOWN");
    assert.equal(rejected.postAttempts, 1, "lỗi nghiệp vụ không được thử lại lần nào");
    assert.equal(rejected.sapDocumentNo, null);
    assert.equal(outboxRows(t, id).length, 0, "lỗi nghiệp vụ → xoá job, KHÔNG retry");

    const events = (await getJson(t.base, `/api/receipts/${id}/events`)).body.items;
    assert.equal(events.filter((e) => e.event === "receipt.post_retry").length, 0);
    const last = events.at(-1);
    assert.equal(last.event, "receipt.rejected");
    assert.equal(last.detail.code, "SAP_PART_UNKNOWN");
    assert.match(last.detail.sapMessage, /does not exist in plant 1000/);

    // Chờ thêm vài tick để chắc chắn không có ai âm thầm gửi lại.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(await statusOf(t.base, id), "rejected");
    assert.equal((await getJson(t.base, `/api/receipts/${id}`)).body.postAttempts, 1);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("retry-post: phiếu post_failed → 202 status posting, attempts về 0; phiếu posted → 409 RECEIPT_STATE_INVALID", async () => {
  const t = await startSapApp({
    sap: { adapter: "mock", maxAttempts: 1, mockSuccessDelayMs: 0 },
    outbox: { enabled: true, tickMs: 20, backoffsMs: [5] },
  });
  try {
    t.app.sim.setGlobal({ sap: { mode: "down" } });
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-retry-001"));
    const id = created.body.receiptId;
    await waitFor(async () => (await statusOf(t.base, id)) === "post_failed", { timeoutMs: 8000, label: "post_failed" });

    t.app.sim.setGlobal({ sap: { mode: "success" } });
    const retry = await postJson(t.base, `/api/receipts/${id}/retry-post`, {}, { "x-device-id": DEVICE_A });
    assert.equal(retry.status, 202);
    assert.equal(retry.body.status, "posting");
    assert.equal(retry.body.attempts, 0);
    assert.equal(retry.body.receiptId, id);
    assert.ok(typeof retry.body.nextAttemptAt === "string");

    const retryEvent = (await getJson(t.base, `/api/receipts/${id}/events`)).body.items.find(
      (e) => e.event === "receipt.retry_requested",
    );
    assert.ok(retryEvent, "phải ghi đúng một sự kiện receipt.retry_requested");
    assert.equal(retryEvent.actor.kind, "operator");
    assert.equal(retryEvent.actor.deviceId, DEVICE_A);
    assert.equal(retryEvent.from, "post_failed");
    assert.equal(retryEvent.to, "posting");

    await waitFor(async () => (await statusOf(t.base, id)) === "posted", { timeoutMs: 8000, label: "posted sau khi gửi lại" });

    const again = await postJson(t.base, `/api/receipts/${id}/retry-post`, {}, { "x-device-id": DEVICE_A });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "RECEIPT_STATE_INVALID");
    assert.equal(again.body.error.message, "Không thực hiện được thao tác này với trạng thái hiện tại của phiếu");
    assert.deepEqual(again.body.error.details, { current: "posted", allowed: ["post_failed"] });
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("retry-post khi SAP_ADAPTER=none → 409 SAP_NOT_CONFIGURED", async () => {
  const t = await startTestApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-nosap-001"));
    const res = await postJson(t.base, `/api/receipts/${created.body.receiptId}/retry-post`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "SAP_NOT_CONFIGURED");
    assert.equal(res.body.error.message, "Chưa cấu hình kết nối SAP");
    assert.deepEqual(res.body.error.details, { adapter: "none" });
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("khởi động lại BE giữa chừng: job state='inflight' được sweep về 'pending', GIỮ NGUYÊN attempts, ghi receipt.swept", async () => {
  const dataDir = tempDataDir();
  let t = await startTestApp({ sap: { adapter: "mock" }, outbox: { enabled: false, tickMs: 20 } }, { dataDir });
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-sweep-001"));
    const id = created.body.receiptId;

    // Mô phỏng "BE chết giữa lúc đang gọi SAP": job inflight, phiếu đang posting, attempts = 3.
    t.app.lifecycle.transition({ receiptId: id, to: "posting", event: "receipt.posting", actorKind: "system", detail: { attempt: 3 } });
    t.app.db.prepare("UPDATE outbox SET state = 'inflight', attempts = 3 WHERE receipt_id = ? AND kind = 'post'").run(id);
    await t.stop();

    // Khởi động lại: tick 60 s nên chỉ sweepOnBoot chạy, worker chưa kịp gửi gì.
    t = await startTestApp({ sap: { adapter: "mock" }, outbox: { enabled: true, tickMs: 60000 } }, { dataDir });

    const rows = outboxRows(t, id);
    assert.equal(rows.length, 1, "job không được biến mất khi BE khởi động lại");
    assert.equal(rows[0].state, "pending", "job inflight mồ côi phải được đưa về pending");
    assert.equal(rows[0].attempts, 3, "sweep KHÔNG được reset attempts, nếu không phiếu retry vô hạn");
    // Phiếu đang posting đọc postAttempts từ outbox.attempts (cột receipts.post_attempts còn 0).
    const seen = await getJson(t.base, `/api/receipts/${id}`);
    assert.equal(seen.body.status, "posting");
    assert.equal(seen.body.postAttempts, 3, "postAttempts của phiếu đang gửi phải lấy từ outbox.attempts");
    assert.equal(t.app.db.prepare("SELECT post_attempts FROM receipts WHERE id = ?").get(id).post_attempts, 0);

    const swept = (await getJson(t.base, `/api/receipts/${id}/events`)).body.items.filter((e) => e.event === "receipt.swept");
    assert.equal(swept.length, 1);
    assert.equal(swept[0].detail.sweep, "posting_stuck");
    assert.equal(swept[0].detail.attempt, 3);
    assert.equal(swept[0].actor.kind, "system");
    assert.equal(swept[0].from, "posting");
    assert.equal(swept[0].to, "posting");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("UNIQUE(receipt_id, kind): enqueue 2 lần cùng receiptId+kind → vẫn chỉ 1 dòng outbox", async () => {
  const t = await startQueueOnlyApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-uniq-0001"));
    const id = created.body.receiptId;
    assert.equal(outboxRows(t, id).length, 1);

    const again = t.app.outbox.enqueue({ receiptId: id, kind: "post", nowIso: new Date().toISOString() });
    const third = t.app.outbox.enqueue({ receiptId: id, kind: "post", nowIso: new Date().toISOString() });

    const rows = outboxRows(t, id);
    assert.equal(rows.length, 1, "UNIQUE(receipt_id, kind) phải chặn job thứ hai");
    assert.equal(again.id, rows[0].id, "enqueue lần hai trả lại job cũ chứ không tạo mới");
    assert.equal(third.id, rows[0].id);

    // kind khác thì vẫn được một dòng riêng.
    t.app.outbox.enqueue({ receiptId: id, kind: "reversal", nowIso: new Date().toISOString() });
    assert.deepEqual(
      outboxRows(t, id).map((r) => r.kind).sort(),
      ["post", "reversal"],
    );
  } finally {
    await t.stop();
    t.cleanup();
  }
});

/* Bảng backoff KHÔNG đồng nhất: mọi giá trị khác nhau, nên một lỗi chỉ số (dùng phần tử đầu,
 * phần tử cuối, hay lệch một) đều làm test đỏ ngay. Bảng ngắn hơn số lần thử để khoá luôn
 * nhánh "hết bảng thì lặp phần tử cuối" của công thức §5.2. */
test("backoff lấy ĐÚNG phần tử thứ (attempts−1): bảng [100,400,900] cho các lần chờ 100/400/900/900, và khoảng cách THẬT giữa các lần gọi SAP tăng theo bảng", async () => {
  const t = await startSapApp({
    sap: { adapter: "mock", maxAttempts: 5 },
    outbox: { enabled: true, tickMs: 20, backoffsMs: [100, 400, 900] },
  });
  try {
    t.app.sim.setGlobal({ sap: { mode: "down" } });
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-backoff-01"));
    const id = created.body.receiptId;
    await waitFor(async () => (await statusOf(t.base, id)) === "post_failed", {
      timeoutMs: 20000,
      label: "phiếu đi hết 5 lần thử rồi sang post_failed",
    });

    const events = (await getJson(t.base, `/api/receipts/${id}/events`)).body.items;
    const retries = events.filter((e) => e.event === "receipt.post_retry");
    assert.deepEqual(
      retries.map((e) => e.detail.attempt),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      retries.map((e) => e.detail.delayMs),
      [100, 400, 900, 900],
      "lần thử thứ n phải dùng backoffsMs[n−1]; hết bảng thì lặp lại phần tử CUỐI",
    );

    /* nextAttemptAt phải thật sự cách thời điểm ghi sự kiện đúng delayMs đã công bố. */
    for (const r of retries) {
      const gap = Date.parse(r.detail.nextAttemptAt) - Date.parse(r.at);
      assert.ok(
        Math.abs(gap - r.detail.delayMs) <= 100,
        `hẹn lần sau phải cách ${r.detail.delayMs} ms, đo được ${gap} ms`,
      );
    }

    /* Và worker phải CHỜ đúng chừng ấy: khoảng cách thật giữa các lần gọi SAP tăng dần. */
    const callAt = events.filter((e) => e.event === "receipt.posting").map((e) => Date.parse(e.at));
    assert.equal(callAt.length, 5, "phải gọi SAP đủ 5 lần");
    const gaps = callAt.slice(1).map((at, i) => at - callAt[i]);
    assert.ok(
      gaps[0] < gaps[1] && gaps[1] < gaps[2],
      `khoảng chờ thật giữa các lần gọi phải tăng theo bảng, đo được ${gaps.join(" / ")} ms`,
    );
    assert.ok(gaps[0] >= 100 && gaps[2] >= 900, `lần chờ đầu ≥ 100 ms và lần thứ ba ≥ 900 ms, đo được ${gaps.join(" / ")} ms`);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

/* CHỐT AN TOÀN L8. Hai phiếu thử nghiệm trong DB thật không có dòng receipt_events nào; nếu
 * sweep S2 nhặt chúng thì một lần NÂNG CẤP PHẦN MỀM sẽ tự bắn dữ liệu cũ sang SAP. */
test("chốt L8: phiếu cũ được backfill 'confirmed' (không có dòng receipt_events) KHÔNG bị sweep đẩy sang SAP; phiếu Phase 4 mất job thì VẪN được sweep và gửi", async () => {
  const dataDir = tempDataDir();
  const legacyIds = ["1a11c0de-0000-4000-8000-000000000001", "1a11c0de-0000-4000-8000-000000000002"];
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();

  /* Bước 1 — dựng lại DB "trước Phase 4": SAP_ADAPTER=none nên không phiếu nào có job outbox. */
  let t = await startTestApp({ sap: { adapter: "none" }, outbox: { enabled: false } }, { dataDir });
  let controlId;
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-l8-control-01"));
    assert.equal(created.status, 201);
    controlId = created.body.receiptId;
    t.app.db.prepare("UPDATE receipts SET created_at = ? WHERE id = ?").run(tenMinutesAgo, controlId);

    /* Phiếu cũ đúng như trong DB thật: status NULL (migrate sẽ backfill) và KHÔNG có sự kiện nào. */
    const insertLegacy = t.app.db.prepare(
      `INSERT INTO receipts (id, request_id, recognition_id, image_id, source, data, field_meta, payload_hash, client_info, created_at, status)
       VALUES (?, ?, NULL, NULL, 'manual', ?, '{}', 'hash-phieu-cu', NULL, ?, NULL)`,
    );
    legacyIds.forEach((id, i) => insertLegacy.run(id, `phieu-cu-truoc-phase4-${i}`, JSON.stringify(validData()), tenMinutesAgo));
    const eventCount = t.app.db.prepare("SELECT COUNT(*) AS n FROM receipt_events WHERE receipt_id IN (?, ?)").get(...legacyIds).n;
    assert.equal(eventCount, 0, "phiếu cũ phải KHÔNG có sự kiện nào thì phép thử mới có nghĩa");
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0);
  } finally {
    await t.stop();
  }

  /* Bước 2 — "nâng cấp": mở đúng DB đó bằng BE có SAP mock và worker chạy thật. */
  const rec = recordingLogger();
  t = await startSapApp(
    { sap: { adapter: "mock", mockSuccessDelayMs: 0 }, outbox: { enabled: true, tickMs: 20 } },
    { dataDir, logger: rec },
  );
  try {
    for (const id of legacyIds) {
      assert.equal(
        t.app.db.prepare("SELECT status FROM receipts WHERE id = ?").get(id).status,
        "confirmed",
        "backfill của migrate() phải điền status cho phiếu cũ",
      );
    }

    /* Đối chứng: phiếu do Phase 4 tạo mà mất job PHẢI được sweep rồi gửi đi — nhờ vậy khẳng
     * định "không gửi" của phiếu cũ là do chốt L8, không phải do worker nằm im. */
    const posted = await waitFor(
      async () => {
        const r = await getJson(t.base, `/api/receipts/${controlId}`);
        return r.body.status === "posted" ? r.body : null;
      },
      { timeoutMs: 8000, label: "phiếu Phase 4 mất job được sweep rồi gửi SAP" },
    );
    assert.match(posted.sapDocumentNo, /^5000\d{6}$/);
    const sweptControl = (await getJson(t.base, `/api/receipts/${controlId}/events`)).body.items.filter(
      (e) => e.event === "receipt.swept",
    );
    assert.equal(sweptControl.length, 1);
    assert.equal(sweptControl[0].detail.sweep, "missing_outbox");

    /* Chốt L8: hai phiếu cũ không job, không sự kiện, không chứng từ SAP. */
    for (const id of legacyIds) {
      assert.equal(outboxRows(t, id).length, 0, "phiếu backfill KHÔNG được đưa vào hàng đợi gửi SAP");
      assert.equal(
        t.app.db.prepare("SELECT COUNT(*) AS n FROM receipt_events WHERE receipt_id = ?").get(id).n,
        0,
        "phiếu backfill không được sinh thêm sự kiện nào",
      );
      const row = t.app.db.prepare("SELECT status, sap_document_no FROM receipts WHERE id = ?").get(id);
      assert.equal(row.status, "confirmed", "phiếu backfill phải đứng yên ở confirmed");
      assert.equal(row.sap_document_no, null, "phiếu backfill không được có số chứng từ SAP");
    }

    const sweepLog = rec.find("outbox.sweep");
    assert.equal(sweepLog.length, 1, "mỗi lần khởi động ghi đúng một dòng outbox.sweep");
    assert.equal(sweepLog[0].missing, 1, "chỉ phiếu Phase 4 được đếm; hai phiếu backfill bị chốt L8 loại ra");
    assert.equal(sweepLog[0].inflight, 0);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

/* SAP đã được gọi (và với SAP thật có thể đã cấp chứng từ mồ côi) — postAttempts phải nói
 * đúng điều đó, nếu không người điều tra sau này không biết phải đi hỏi SAP. */
test("huỷ phiếu ĐÚNG LÚC worker đang gọi SAP: kết quả cũ bị bỏ (vẫn cancelled, không sapDocumentNo) nhưng postAttempts GIỮ số lần đã gọi SAP = 1", async () => {
  const rec = recordingLogger();
  const t = await startSapApp(
    { sap: { adapter: "mock", mockSlowDelayMs: 1000 }, outbox: { enabled: true, tickMs: 20 } },
    { logger: rec },
  );
  try {
    t.app.sim.setGlobal({ sap: { mode: "slow" } });
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-ob-race-0001"));
    const id = created.body.receiptId;

    // Chờ worker bắt đầu gọi SAP (phiếu đã sang posting), rồi huỷ trong lúc SAP còn đang chạy.
    await waitFor(async () => (await statusOf(t.base, id)) === "posting", { timeoutMs: 8000, label: "phiếu sang posting" });
    const cancelled = await postJson(t.base, `/api/receipts/${id}/cancel`, { reason: "Huỷ giữa lúc gửi SAP" }, { "x-device-id": DEVICE_A });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");

    // Khi SAP trả về, worker phát hiện kết quả đã cũ, ghi log và dọn job.
    await waitFor(async () => rec.find("outbox.stale_result").length === 1, {
      timeoutMs: 8000,
      label: "worker ghi outbox.stale_result",
    });
    await waitFor(async () => outboxRows(t, id).length === 0, { timeoutMs: 8000, label: "job bị dọn" });

    const after = (await getJson(t.base, `/api/receipts/${id}`)).body;
    assert.equal(after.status, "cancelled", "kết quả SAP đến muộn không được lật trạng thái phiếu");
    assert.equal(after.sapDocumentNo, null);
    assert.equal(after.postAttempts, 1, "SAP đã được gọi 1 lần: postAttempts không được nói dối là 0");
    assert.equal(t.app.db.prepare("SELECT post_attempts FROM receipts WHERE id = ?").get(id).post_attempts, 1);

    const events = (await getJson(t.base, `/api/receipts/${id}/events`)).body.items;
    assert.deepEqual(
      events.map((e) => e.event),
      ["receipt.confirmed", "receipt.posting", "receipt.cancelled"],
      "không được sinh thêm sự kiện nào cho kết quả SAP đã cũ",
    );
  } finally {
    await t.stop();
    t.cleanup();
  }
});
