import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startTestApp, postJson, getJson, receiptBody, DEVICE_A, DEVICE_B } from "./helpers.js";

const ALL_STATUSES = ["confirmed", "posting", "posted", "post_failed", "rejected", "cancelled", "corrected", "superseded"];

const SESSION_A = "6a1f0f0d-3cc4-4b26-9a2e-1e8be2b1c7a4";
const SESSION_B = "2b7d4c1e-8f30-4a55-9c6b-3e1a7d9f0c22";

/* Tạo phiếu kèm header thiết bị/phiên. Mỗi lần gọi chờ 2 ms để created_at khác nhau,
 * nhờ vậy thứ tự mới-nhất-trước là tất định. */
async function make(base, requestId, { deviceId, sessionId } = {}) {
  const headers = {};
  if (deviceId) headers["x-device-id"] = deviceId;
  if (sessionId) headers["x-session-id"] = sessionId;
  const res = await postJson(base, "/api/receipts", receiptBody(requestId), headers);
  assert.equal(res.status, 201, `tạo phiếu ${requestId} thất bại: ${JSON.stringify(res.body)}`);
  await new Promise((r) => setTimeout(r, 2));
  return res.body;
}

test("GET /api/receipts?sessionId= lọc đúng; phiếu của phiên khác không lọt vào", async () => {
  const t = await startTestApp();
  try {
    const a1 = await make(t.base, "req-q-ses-000001", { deviceId: DEVICE_A, sessionId: SESSION_A });
    const a2 = await make(t.base, "req-q-ses-000002", { deviceId: DEVICE_A, sessionId: SESSION_A });
    const b1 = await make(t.base, "req-q-ses-000003", { deviceId: DEVICE_B, sessionId: SESSION_B });

    const res = await getJson(t.base, `/api/receipts?sessionId=${SESSION_A}`);
    assert.equal(res.status, 200);
    const ids = res.body.items.map((r) => r.receiptId);
    assert.deepEqual(ids.sort(), [a1.receiptId, a2.receiptId].sort());
    assert.equal(ids.includes(b1.receiptId), false, "phiếu của phiên khác không được lọt vào");
    assert.equal(res.body.counts.total, 2);

    const bad = await getJson(t.base, "/api/receipts?sessionId=khong-phai-uuid");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_QUERY");
    assert.equal(bad.body.error.message, "Tham số truy vấn không hợp lệ");
    assert.equal(bad.body.error.details.field, "sessionId");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/receipts?deviceId= lọc đúng; kết hợp sessionId + deviceId cho giao của hai điều kiện", async () => {
  const t = await startTestApp();
  try {
    const aa = await make(t.base, "req-q-dev-000001", { deviceId: DEVICE_A, sessionId: SESSION_A });
    const ab = await make(t.base, "req-q-dev-000002", { deviceId: DEVICE_A, sessionId: SESSION_B });
    const bb = await make(t.base, "req-q-dev-000003", { deviceId: DEVICE_B, sessionId: SESSION_B });

    const byDevice = await getJson(t.base, `/api/receipts?deviceId=${DEVICE_A}`);
    assert.deepEqual(
      byDevice.body.items.map((r) => r.receiptId).sort(),
      [aa.receiptId, ab.receiptId].sort(),
    );

    const both = await getJson(t.base, `/api/receipts?deviceId=${DEVICE_A}&sessionId=${SESSION_B}`);
    assert.deepEqual(
      both.body.items.map((r) => r.receiptId),
      [ab.receiptId],
      "kết hợp hai bộ lọc phải cho GIAO, không phải hợp",
    );
    assert.equal(both.body.items.includes(bb.receiptId), false);
    assert.equal(both.body.counts.total, 1);

    const bad = await getJson(t.base, "/api/receipts?deviceId=ABC");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.details.field, "deviceId");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/receipts?status=posted,rejected lọc đúng nhiều trạng thái; status lạ → 400 INVALID_QUERY", async () => {
  const t = await startTestApp();
  try {
    const posted = await make(t.base, "req-q-st-0000001");
    const rejected = await make(t.base, "req-q-st-0000002");
    await make(t.base, "req-q-st-0000003"); // ở lại confirmed

    const { lifecycle } = t.app;
    lifecycle.transition({ receiptId: posted.receiptId, to: "posting", event: "receipt.posting", actorKind: "system" });
    lifecycle.transition({ receiptId: posted.receiptId, to: "posted", event: "receipt.posted", actorKind: "system" });
    lifecycle.transition({ receiptId: rejected.receiptId, to: "posting", event: "receipt.posting", actorKind: "system" });
    lifecycle.transition({ receiptId: rejected.receiptId, to: "rejected", event: "receipt.rejected", actorKind: "system" });

    const res = await getJson(t.base, "/api/receipts?status=posted,rejected");
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((r) => r.receiptId).sort(),
      [posted.receiptId, rejected.receiptId].sort(),
    );
    assert.deepEqual(res.body.items.map((r) => r.status).sort(), ["posted", "rejected"]);

    // Khoảng trắng quanh dấu phẩy được trim trước khi kiểm enum.
    const spaced = await getJson(t.base, "/api/receipts?status=posted, rejected");
    assert.equal(spaced.body.items.length, 2);

    // Chuỗi rỗng = không lọc, KHÔNG phải lỗi.
    const empty = await getJson(t.base, "/api/receipts?status=");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.items.length, 3);

    const bad = await getJson(t.base, "/api/receipts?status=posted,khong-co-that");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_QUERY");
    assert.equal(bad.body.error.details.field, "status");
    assert.deepEqual(bad.body.error.details.allowed, ALL_STATUSES);

    // draft/queued chỉ tồn tại trên PDA ở Phase 5 — server không nhận.
    const draft = await getJson(t.base, "/api/receipts?status=draft");
    assert.equal(draft.status, 400);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/receipts?limit=2 + cursor: 3 trang liên tiếp không trùng, không sót, nextCursor cuối = null", async () => {
  const t = await startTestApp();
  try {
    const created = [];
    for (let i = 1; i <= 5; i += 1) created.push(await make(t.base, `req-q-cur-000000${i}`));
    const newestFirst = created.map((r) => r.receiptId).reverse();

    const seen = [];
    let cursor = null;
    let pages = 0;
    for (;;) {
      const url = `/api/receipts?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await getJson(t.base, url);
      assert.equal(res.status, 200);
      pages += 1;
      seen.push(...res.body.items.map((r) => r.receiptId));
      cursor = res.body.nextCursor;
      if (!cursor) break;
      assert.ok(pages < 10, "phân trang không được lặp vô hạn");
    }

    assert.equal(pages, 3, "5 phiếu với limit=2 phải ra đúng 3 trang");
    assert.equal(cursor, null, "trang cuối phải có nextCursor = null");
    assert.deepEqual(seen, newestFirst, "3 trang ghép lại phải đúng 5 phiếu, mới nhất trước, không trùng không sót");
    assert.equal(new Set(seen).size, 5);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("cursor hỏng → 400 INVALID_CURSOR; limit=abc → dùng mặc định 20 (tương thích Phase 1)", async () => {
  const t = await startTestApp();
  try {
    for (let i = 1; i <= 3; i += 1) await make(t.base, `req-q-badcur-00${i}`);

    for (const bad of ["khong-phai-cursor", "!!!", Buffer.from("khong-co-gach-dung").toString("base64url")]) {
      const res = await getJson(t.base, `/api/receipts?cursor=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `cursor "${bad}" phải bị từ chối`);
      assert.equal(res.body.error.code, "INVALID_CURSOR");
      assert.equal(res.body.error.message, "Con trỏ phân trang không hợp lệ");
    }

    // limit không parse được: giữ hành vi khoan dung của Phase 1 (Number(...) || 20).
    const lenient = await getJson(t.base, "/api/receipts?limit=abc");
    assert.equal(lenient.status, 200);
    assert.equal(lenient.body.items.length, 3);
    assert.equal(lenient.body.nextCursor, null);

    // Parse được nhưng ngoài khoảng → kẹp về [1, 200].
    const clamped = await getJson(t.base, "/api/receipts?limit=9999");
    assert.equal(clamped.status, 200);
    assert.equal(clamped.body.items.length, 3);
    const one = await getJson(t.base, "/api/receipts?limit=-5");
    assert.equal(one.body.items.length, 1, "limit âm phải kẹp về 1");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("counts.byStatus luôn đủ 8 key và BỎ QUA bộ lọc status, nhưng CHỊU bộ lọc sessionId", async () => {
  const t = await startTestApp();
  try {
    const a1 = await make(t.base, "req-q-cnt-000001", { sessionId: SESSION_A });
    await make(t.base, "req-q-cnt-000002", { sessionId: SESSION_A });
    await make(t.base, "req-q-cnt-000003", { sessionId: SESSION_B });

    t.app.lifecycle.transition({ receiptId: a1.receiptId, to: "posting", event: "receipt.posting", actorKind: "system" });

    const filtered = await getJson(t.base, "/api/receipts?status=posting");
    assert.equal(filtered.body.items.length, 1, "bộ lọc status vẫn phải lọc items");
    assert.deepEqual(Object.keys(filtered.body.counts.byStatus).sort(), [...ALL_STATUSES].sort());
    assert.equal(filtered.body.counts.total, 3, "counts BỎ QUA bộ lọc status — nếu không chip lọc trên S6 về 0");
    assert.equal(filtered.body.counts.byStatus.confirmed, 2);
    assert.equal(filtered.body.counts.byStatus.posting, 1);
    assert.equal(filtered.body.counts.byStatus.posted, 0);
    assert.equal(filtered.body.counts.byStatus.cancelled, 0);

    const scoped = await getJson(t.base, `/api/receipts?sessionId=${SESSION_A}&status=posting`);
    assert.equal(scoped.body.counts.total, 2, "counts CHỊU bộ lọc sessionId");
    assert.equal(scoped.body.counts.byStatus.confirmed, 1);
    assert.equal(scoped.body.counts.byStatus.posting, 1);
    assert.equal(
      Object.values(scoped.body.counts.byStatus).reduce((a, b) => a + b, 0),
      scoped.body.counts.total,
      "total phải bằng tổng 8 giá trị của byStatus",
    );
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/receipts (không tham số) giữ tương thích: items là mảng mới-nhất-trước, có thêm nextCursor/counts/serverTime", async () => {
  const t = await startTestApp();
  try {
    const first = await make(t.base, "req-q-compat-0001");
    const second = await make(t.base, "req-q-compat-0002");

    const res = await getJson(t.base, "/api/receipts");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.deepEqual(
      res.body.items.map((r) => r.receiptId),
      [second.receiptId, first.receiptId],
      "thứ tự mới-nhất-trước của Phase 1 không đổi",
    );
    assert.equal(res.body.nextCursor, null);
    assert.equal(res.body.counts.total, 2);
    assert.ok(typeof res.body.serverTime === "string" && res.body.serverTime.endsWith("Z"));

    // Cách gọi cũ list(số nguyên) vẫn phải chạy — 95 test cũ và code cũ dựa vào nó.
    const legacy = t.app.receipts.list(1);
    assert.equal(legacy.items.length, 1);
    assert.equal(legacy.items[0].receiptId, second.receiptId);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("response phiếu có đủ 7 field mới với giá trị mặc định đúng (status='confirmed', 5 null, postAttempts=0)", async () => {
  const t = await startTestApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-q-fields-001"));
    const id = created.body.receiptId;

    const expected = {
      status: "confirmed",
      sapDocumentNo: null,
      supersedesReceiptId: null,
      supersededByReceiptId: null,
      rejectCode: null,
      postAttempts: 0,
      cancelReason: null,
    };
    const pick = (obj) => Object.fromEntries(Object.keys(expected).map((k) => [k, obj[k]]));

    assert.deepEqual(pick(created.body), expected, "POST /api/receipts thiếu hoặc sai 7 field mới");
    assert.deepEqual(pick((await getJson(t.base, `/api/receipts/${id}`)).body), expected, "GET /api/receipts/:id thiếu 7 field mới");
    assert.deepEqual(pick((await getJson(t.base, "/api/receipts")).body.items[0]), expected, "items[] thiếu 7 field mới");

    // Phiếu cũ chưa qua backfill (status IS NULL) vẫn phải trả status hợp lệ.
    const legacyId = crypto.randomUUID();
    t.app.db
      .prepare(
        "INSERT INTO receipts (id, request_id, recognition_id, image_id, source, data, field_meta, payload_hash, client_info, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(legacyId, "req-q-legacy-001", null, null, "manual", JSON.stringify({ partNumber: "OLD" }), "{}", "h", null, "2026-09-01T10:00:00.000Z");
    const legacy = await getJson(t.base, `/api/receipts/${legacyId}`);
    assert.equal(legacy.body.status, "confirmed", "status IS NULL phải hiện ra là confirmed");
    assert.equal(legacy.body.postAttempts, 0);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

/* §2.1 tách hai bước: KHÔNG parse được → mặc định 20; parse được nhưng ngoài khoảng → kẹp về
 * [1, 200]. Số 0 parse được, nên nó thuộc vế thứ hai. */
test("GET /api/receipts?limit=0 → kẹp về 1 dòng (không rơi về mặc định 20); ?limit= rỗng và ?limit=abc mới dùng mặc định 20", async () => {
  const t = await startTestApp();
  try {
    for (let i = 1; i <= 25; i += 1) await make(t.base, `req-q-limit0-${String(i).padStart(3, "0")}`);

    const zero = await getJson(t.base, "/api/receipts?limit=0");
    assert.equal(zero.status, 200);
    assert.equal(zero.body.items.length, 1, "limit=0 phải kẹp về 1, không được trả 20 dòng");
    assert.ok(zero.body.nextCursor, "vẫn còn trang sau");

    assert.equal((await getJson(t.base, "/api/receipts?limit=")).body.items.length, 20, "limit rỗng = không gửi → mặc định 20");
    assert.equal((await getJson(t.base, "/api/receipts?limit=abc")).body.items.length, 20);
    assert.equal((await getJson(t.base, "/api/receipts?limit=0.4")).body.items.length, 1, "phần thập phân cắt xuống rồi mới kẹp");
    assert.equal((await getJson(t.base, "/api/receipts?limit=2")).body.items.length, 2, "giá trị hợp lệ không bị đụng tới");
    assert.equal((await getJson(t.base, "/api/receipts?limit=500")).body.items.length, 25, "kẹp về 200, DB chỉ có 25 dòng");

    // counts KHÔNG chịu ảnh hưởng của limit: chip lọc trên S6 luôn đếm đủ.
    assert.equal(zero.body.counts.total, 25);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
