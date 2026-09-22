import { test } from "node:test";
import assert from "node:assert/strict";
import { startRulesApp, postJson, getJson, receiptBody, validData, DEVICE_A, DEVICE_B } from "./helpers.js";
import { findDuplicate, localDay } from "../src/rules/duplicate.js";

const hdr = (deviceId, sessionId) => ({ "x-device-id": deviceId, ...(sessionId ? { "x-session-id": sessionId } : {}) });

async function startSession(t, deviceId, warehouse) {
  const res = await postJson(t.base, "/api/sessions/start", { operator: "Kiểm thử", warehouse, shift: "sang" }, { "x-device-id": deviceId });
  assert.equal(res.status, 201);
  return res.body.session.sessionId ?? res.body.session.id;
}

test("json_extract khả dụng: truy vấn thử trên receipts.data trả đúng partNumber (nếu fail, chuyển sang đọc JSON trong JS)", async () => {
  const t = await startRulesApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("json-extract-0001"));
    assert.equal(created.status, 201);

    const row = t.app.db
      .prepare("SELECT json_extract(data, '$.partNumber') AS pn, COALESCE(json_extract(data, '$.batch'), '') AS b FROM receipts WHERE id = ?")
      .get(created.body.receiptId);
    assert.equal(row.pn, "BEX32181030AB", "node:sqlite phải có JSON1 — nếu không, rule trùng nhãn phải đọc JSON trong JS");
    assert.equal(row.b, "", "batch null phải COALESCE về chuỗi rỗng đúng như khoá trùng yêu cầu");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("trùng nhãn: phiếu thứ hai cùng partNumber+batch+saNumber+kho+ngày → 409 DUPLICATE_LABEL với details.existingReceiptId đúng", async () => {
  const t = await startRulesApp();
  try {
    const sessionId = await startSession(t, DEVICE_A, "Kho Long Biên");
    const first = await postJson(t.base, "/api/receipts", receiptBody("dup-first-000001"), hdr(DEVICE_A, sessionId));
    assert.equal(first.status, 201);

    const second = await postJson(t.base, "/api/receipts", receiptBody("dup-second-00001"), hdr(DEVICE_A, sessionId));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "DUPLICATE_LABEL");
    assert.equal(second.body.error.message, "Nhãn này đã được nhập hôm nay");

    const d = second.body.error.details;
    assert.equal(d.existingReceiptId, first.body.receiptId);
    assert.equal(d.existingCreatedAt, first.body.createdAt);
    assert.equal(d.existingDeviceId, DEVICE_A);
    assert.equal(d.existingStatus, "confirmed");
    assert.deepEqual(Object.keys(d.key).sort(), ["batch", "day", "partNumber", "saNumber", "warehouse"]);
    assert.deepEqual(d.key, {
      partNumber: "BEX32181030AB",
      batch: null,
      saNumber: null,
      warehouse: "Kho Long Biên",
      day: localDay(first.body.createdAt, 420),
    });

    /* Phiếu thứ hai KHÔNG được lưu: 409 là chặn, không phải cảnh báo. */
    const list = await getJson(t.base, "/api/receipts?limit=200");
    assert.equal(list.body.items.length, 1);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("trùng nhãn: allowDuplicate=true → 201, và GET /api/receipts/:id/events có dòng receipt.duplicate_override", async () => {
  const t = await startRulesApp();
  try {
    const first = await postJson(t.base, "/api/receipts", receiptBody("ovr-first-000001"), hdr(DEVICE_A));
    assert.equal(first.status, 201);

    const blocked = await postJson(t.base, "/api/receipts", receiptBody("ovr-second-00001"), hdr(DEVICE_A));
    assert.equal(blocked.status, 409, "chưa xác nhận thì phải bị chặn trước đã");

    /* Bước 4 của luồng 2 bước: CÙNG requestId, CÙNG data, thêm allowDuplicate. */
    const forced = await postJson(t.base, "/api/receipts", receiptBody("ovr-second-00001", { allowDuplicate: true }), hdr(DEVICE_A));
    assert.equal(forced.status, 201);
    assert.notEqual(forced.body.receiptId, first.body.receiptId);
    assert.equal(forced.body.status, "confirmed");

    const events = await getJson(t.base, `/api/receipts/${forced.body.receiptId}/events`);
    assert.equal(events.status, 200);
    const override = events.body.items.filter((e) => e.event === "receipt.duplicate_override");
    assert.equal(override.length, 1, "phải ghi đúng một dòng receipt.duplicate_override");
    assert.equal(override[0].detail.existingReceiptId, first.body.receiptId);
    assert.equal(override[0].detail.key.partNumber, "BEX32181030AB");
    assert.equal(override[0].to, "confirmed", "ghi chú không được đổi trạng thái phiếu");

    /* Phiếu đầu tiên không có dòng nào: sự kiện gắn vào phiếu MỚI, không phải phiếu cũ. */
    const firstEvents = await getJson(t.base, `/api/receipts/${first.body.receiptId}/events`);
    assert.equal(firstEvents.body.items.filter((e) => e.event === "receipt.duplicate_override").length, 0);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("trùng nhãn: đổi batch hoặc saNumber hoặc kho (phiên khác warehouse) → KHÔNG trùng, 201", async () => {
  const t = await startRulesApp();
  try {
    const sessionLB = await startSession(t, DEVICE_A, "Kho Long Biên");
    const base = await postJson(t.base, "/api/receipts", receiptBody("key-base-000001"), hdr(DEVICE_A, sessionLB));
    assert.equal(base.status, 201);

    /* Đổi batch → khoá khác → lưu được. */
    const otherBatch = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("key-batch-00001", { data: { ...validData(), batch: "LO-2026-09" } }),
      hdr(DEVICE_A, sessionLB),
    );
    assert.equal(otherBatch.status, 201, "batch khác thì không phải cùng một nhãn");

    /* Đổi saNumber → khoá khác. */
    const otherSa = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("key-sa-000000001", { data: { ...validData(), saNumber: "1234567890" } }),
      hdr(DEVICE_A, sessionLB),
    );
    assert.equal(otherSa.status, 201, "saNumber khác thì không phải cùng một nhãn");

    /* Cùng nhãn nhưng kho khác (phiên của thiết bị khác, warehouse khác) → không trùng. */
    const sessionHD = await startSession(t, DEVICE_B, "Kho Hải Dương");
    const otherWarehouse = await postJson(t.base, "/api/receipts", receiptBody("key-wh-000000001"), hdr(DEVICE_B, sessionHD));
    assert.equal(otherWarehouse.status, 201, "kho khác thì không phải cùng một nhãn");

    /* Đối chứng: y hệt phiếu đầu, cùng kho → vẫn phải 409, nếu không phép thử trên vô nghĩa. */
    const same = await postJson(t.base, "/api/receipts", receiptBody("key-same-000001"), hdr(DEVICE_A, sessionLB));
    assert.equal(same.status, 409);
    assert.equal(same.body.error.details.existingReceiptId, base.body.receiptId);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("trùng nhãn: phiếu cũ đã cancelled hoặc superseded → KHÔNG tính là trùng, 201", async () => {
  const t = await startRulesApp();
  try {
    /* (1) Phiếu đã huỷ không chặn phiếu mới. */
    const cancelledOne = await postJson(t.base, "/api/receipts", receiptBody("cxl-first-000001"), hdr(DEVICE_A));
    assert.equal(cancelledOne.status, 201);
    const cancelled = await postJson(
      t.base,
      `/api/receipts/${cancelledOne.body.receiptId}/cancel`,
      { reason: "Nhập nhầm pallet" },
      hdr(DEVICE_A),
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");

    const afterCancel = await postJson(t.base, "/api/receipts", receiptBody("cxl-second-00001"), hdr(DEVICE_A));
    assert.equal(afterCancel.status, 201, "phiếu đã huỷ không được tính là trùng (Q33)");

    /* (2) Phiếu đã bị thay thế cũng không chặn. Phiếu sửa mang partNumber KHÁC để chỉ còn đúng
     * phiếu superseded giữ nhãn cũ. */
    const sup = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("sup-first-000001", { data: { ...validData(), partNumber: "BEX32181030XX" } }),
      hdr(DEVICE_A),
    );
    assert.equal(sup.status, 201);
    const corrected = await postJson(
      t.base,
      `/api/receipts/${sup.body.receiptId}/correct`,
      { requestId: "sup-correct-0001", data: { ...validData(), partNumber: "BEX32181030YY" }, reason: "Nhầm mã" },
      hdr(DEVICE_A),
    );
    assert.equal(corrected.status, 201);
    assert.equal((await getJson(t.base, `/api/receipts/${sup.body.receiptId}`)).body.status, "superseded");

    const afterSupersede = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("sup-second-00001", { data: { ...validData(), partNumber: "BEX32181030XX" } }),
      hdr(DEVICE_A),
    );
    assert.equal(afterSupersede.status, 201, "phiếu đã bị thay thế không được tính là trùng (Q33)");

    /* Đối chứng: nhãn của phiếu SỬA (đang sống) vẫn chặn phiếu mới. */
    const stillBlocked = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("sup-third-000001", { data: { ...validData(), partNumber: "BEX32181030YY" } }),
      hdr(DEVICE_A),
    );
    assert.equal(stillBlocked.status, 409);
    assert.equal(stillBlocked.body.error.details.existingReceiptId, corrected.body.receiptId);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("idempotency thắng rule: gửi lại CÙNG requestId sau khi đã lưu → 200 idempotent, KHÔNG bị 409 DUPLICATE_LABEL", async () => {
  const t = await startRulesApp();
  try {
    const first = await postJson(t.base, "/api/receipts", receiptBody("idem-rule-000001"), hdr(DEVICE_A));
    assert.equal(first.status, 201);
    assert.equal(first.body.idempotent, false);

    /* Đây chính là lần retry của transport.js: cùng requestId, cùng payload. Nếu rule chạy
     * trước bước idempotency (Q30), phiếu sẽ tự phát hiện CHÍNH MÌNH là trùng và trả 409 cho
     * một phiếu chưa hề tồn tại lần hai. */
    const again = await postJson(t.base, "/api/receipts", receiptBody("idem-rule-000001"), hdr(DEVICE_A));
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.receiptId, first.body.receiptId);

    /* Vẫn chỉ có đúng một phiếu trong DB. */
    const list = await getJson(t.base, "/api/receipts?limit=200");
    assert.equal(list.body.items.length, 1);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test('vị trí ngoài danh mục → 422 LOCATION_UNKNOWN với details.field="location" và suggestions là mảng ≤ 3; vị trí hợp lệ → 201', async () => {
  const t = await startRulesApp();
  try {
    const bad = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("loc-bad-00000001", { data: { ...validData(), location: "A-99-99" } }),
      hdr(DEVICE_A),
    );
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, "LOCATION_UNKNOWN");
    assert.equal(bad.body.error.message, "Vị trí không có trong danh mục kho");
    assert.equal(bad.body.error.details.field, "location");
    assert.equal(bad.body.error.details.value, "A-99-99");
    assert.ok(Array.isArray(bad.body.error.details.suggestions));
    assert.ok(bad.body.error.details.suggestions.length <= 3);
    assert.equal(
      bad.body.error.details.suggestions.every((c) => c.startsWith("A")),
      true,
      "gợi ý phải cùng ký tự đầu với giá trị đã nhập",
    );

    /* Không mã nào cùng ký tự đầu → mảng RỖNG, không bao giờ vắng key. */
    const noMatch = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("loc-none-0000001", { data: { ...validData(), location: "Z-01-01" } }),
      hdr(DEVICE_A),
    );
    assert.equal(noMatch.status, 422);
    assert.ok("suggestions" in noMatch.body.error.details);
    assert.deepEqual(noMatch.body.error.details.suggestions, []);

    /* Chữ thường vẫn được validateReceiptData chuẩn hoá về hoa trước khi kiểm danh mục. */
    const lower = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("loc-lower-000001", { data: { ...validData(), location: "a-03-02" } }),
      hdr(DEVICE_A),
    );
    assert.equal(lower.status, 201);
    assert.equal(lower.body.data.location, "A-03-02");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("trùng nhãn tính theo NGÀY ĐỊA PHƯƠNG (TZ_OFFSET_MINUTES=420): cặp 00:30 và 23:30 giờ VN (khác ngày UTC) → TRÙNG; cặp cùng ngày UTC nhưng khác ngày địa phương → KHÔNG trùng", async () => {
  const t = await startRulesApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("tz-boundary-0001"), hdr(DEVICE_A));
    assert.equal(created.status, 201);
    const receiptId = created.body.receiptId;
    const data = t.app.receipts.get(receiptId).data;
    /* created_at luôn là "bây giờ" khi đi qua API, nên phải đặt tay về đúng mốc cần thử.
     * Đây là dàn cảnh của test, không phải đường ghi dữ liệu của mã nguồn. */
    const setCreatedAt = (iso) => t.app.db.prepare("UPDATE receipts SET created_at = ? WHERE id = ?").run(iso, receiptId);
    const find = (nowIso, tzOffsetMinutes = 420) => findDuplicate({ db: t.app.db, data, sessionId: null, nowIso, tzOffsetMinutes });

    /* (1) Hai phiếu CÙNG ngày địa phương 2026-09-21 nhưng KHÁC ngày UTC:
     *     00:30 giờ VN = 2026-09-20T17:30Z  ·  23:30 giờ VN = 2026-09-21T16:30Z
     *     Quy tắc ngày UTC sẽ bỏ sót đúng cặp này. */
    setCreatedAt("2026-09-20T17:30:00.000Z");
    const sameLocalDay = find("2026-09-21T16:30:00.000Z");
    assert.ok(sameLocalDay, "00:30 và 23:30 cùng một ngày làm việc ở VN → phải phát hiện trùng");
    assert.equal(sameLocalDay.receiptId, receiptId);
    assert.equal(sameLocalDay.key.day, "2026-09-21");

    /* Cùng dữ liệu đó, nếu tính theo ngày UTC (offset 0) thì hai mốc rơi vào 09-20 và 09-21
     * → KHÔNG phát hiện. Đây là lý do Q32 bản UTC bị bác. */
    assert.equal(find("2026-09-21T16:30:00.000Z", 0), null, "offset phải thực sự được dùng, không phải hằng số chết");

    /* (2) Mốc 00:00 UTC = 07:00 giờ VN, giữa ca sáng: 06:50 và 07:10 giờ VN cách nhau 20 phút,
     *     khác ngày UTC nhưng cùng ngày làm việc → phải cảnh báo. */
    setCreatedAt("2026-09-20T23:50:00.000Z");
    const acrossUtcMidnight = find("2026-09-21T00:10:00.000Z");
    assert.ok(acrossUtcMidnight, "hai phiếu cách nhau 20 phút quanh 07:00 giờ VN phải bị coi là trùng");
    assert.equal(acrossUtcMidnight.key.day, "2026-09-21");

    /* (3) Chiều ngược lại: CÙNG ngày UTC 2026-09-21 nhưng khác ngày địa phương
     *     (23:30 ngày 21 và 00:30 ngày 22 giờ VN) → KHÔNG phải cùng một ngày làm việc. */
    setCreatedAt("2026-09-21T16:30:00.000Z");
    assert.equal(find("2026-09-21T17:30:00.000Z"), null, "sang ngày làm việc mới thì không còn là trùng nhãn");

    /* (4) Ranh giới sát nút của ngày địa phương 2026-09-21: 17:00Z hôm trước là 00:00 giờ VN
     *     (nằm trong), 16:59:59.999Z cùng ngày UTC là 23:59:59.999 giờ VN (vẫn trong). */
    setCreatedAt("2026-09-20T17:00:00.000Z");
    assert.ok(find("2026-09-21T16:59:59.999Z"), "đầu ngày địa phương phải nằm trong khoảng");
    setCreatedAt("2026-09-20T16:59:59.999Z");
    assert.equal(find("2026-09-21T16:59:59.999Z"), null, "trước 00:00 giờ VN là ngày hôm trước");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

const DAY_MS = 86_400_000;
/* Nửa khoảng UTC [start, end) phủ ngày địa phương chứa mốc `nowMs`. Tính lại độc lập ngay trong
 * test, không gọi hàm của mã sản phẩm, để đây là một cái mốc đối chứng thật sự. */
function localDayWindow(nowMs, tzOffsetMinutes) {
  const shifted = nowMs + tzOffsetMinutes * 60_000;
  const startShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return { start: startShifted - tzOffsetMinutes * 60_000, end: startShifted + DAY_MS - tzOffsetMinutes * 60_000 };
}

/* Đường dây env → loadConfig → createRules → findDuplicate: rules.test.js ở trên gọi thẳng
 * findDuplicate với tham số tzOffsetMinutes nên không kiểm được đoạn dây này. Ghim cứng bất kỳ
 * hằng số nào (420, hay 0 = giờ UTC) đều làm hai vế dưới đây cho CÙNG một kết quả → test đỏ. */
test("config.tzOffsetMinutes thật sự tới được rule trùng nhãn: CÙNG một mốc created_at, BE chạy múi +420 trả 409 DUPLICATE_LABEL còn BE chạy múi −300 trả 201", async () => {
  const now = Date.now();
  const inVn = localDayWindow(now, 420);
  const inUs = localDayWindow(now, -300);
  /* Hai cửa sổ lệch nhau 12 giờ, nên luôn có mốc nằm trong ngày làm việc UTC+7 mà ngoài UTC−5. */
  const createdAtMs = inUs.start > inVn.start ? inVn.start + 60_000 : inUs.end + 60_000;
  const createdAt = new Date(createdAtMs).toISOString();
  assert.ok(createdAtMs >= inVn.start && createdAtMs < inVn.end, "mốc phải nằm TRONG ngày làm việc của múi +420");
  assert.ok(createdAtMs < inUs.start || createdAtMs >= inUs.end, "và NGOÀI ngày làm việc của múi −300");

  const runWithOffset = async (tzOffsetMinutes) => {
    const t = await startRulesApp({ tzOffsetMinutes });
    try {
      const first = await postJson(t.base, "/api/receipts", receiptBody(`tz-wire-a-${tzOffsetMinutes}`), hdr(DEVICE_A));
      assert.equal(first.status, 201);
      t.app.db.prepare("UPDATE receipts SET created_at = ? WHERE id = ?").run(createdAt, first.body.receiptId);

      const second = await postJson(t.base, "/api/receipts", receiptBody(`tz-wire-b-${tzOffsetMinutes}`), hdr(DEVICE_A));
      return { first: first.body.receiptId, second };
    } finally {
      await t.stop();
      t.cleanup();
    }
  };

  const vn = await runWithOffset(420);
  assert.equal(vn.second.status, 409, `múi +420: ${createdAt} vẫn là hôm nay → phải cảnh báo trùng nhãn`);
  assert.equal(vn.second.body.error.code, "DUPLICATE_LABEL");
  assert.equal(vn.second.body.error.details.existingReceiptId, vn.first);

  const us = await runWithOffset(-300);
  assert.equal(us.second.status, 201, `múi −300: ${createdAt} đã là ngày làm việc khác → KHÔNG được coi là trùng`);
  assert.ok(us.second.body.receiptId);
});

/* Mã ngừng dùng không bao giờ xuất hiện trong danh mục gợi ý, nên nhận phiếu vào nó là
 * nhận một vị trí mà chính giao diện coi như không tồn tại. */
test("vị trí active=false (B-01-07) → 422 LOCATION_UNKNOWN y như mã ngoài danh mục, và gợi ý chỉ chứa mã đang hoạt động", async () => {
  const t = await startRulesApp();
  try {
    const hidden = await getJson(t.base, "/api/master/locations?q=B-01-07");
    assert.equal(hidden.body.items.length, 0, "danh mục mặc định KHÔNG chào B-01-07 thì BE cũng không được nhận");
    const shown = await getJson(t.base, "/api/master/locations?q=B-01-07&includeInactive=true");
    assert.equal(shown.body.items.length, 1);
    assert.equal(shown.body.items[0].active, false, "B-01-07 phải là mã active=false thì phép thử mới có nghĩa");

    const res = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("loc-inactive-0001", { data: { ...validData(), location: "B-01-07" } }),
      hdr(DEVICE_A),
    );
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "LOCATION_UNKNOWN");
    assert.equal(res.body.error.details.field, "location");
    assert.equal(res.body.error.details.value, "B-01-07");
    for (const code of res.body.error.details.suggestions) {
      const one = await getJson(t.base, `/api/master/locations?q=${code}`);
      assert.equal(one.body.items[0]?.active, true, `gợi ý ${code} phải là vị trí đang hoạt động`);
    }
    assert.equal((await getJson(t.base, "/api/receipts?limit=200")).body.items.length, 0, "422 phải chặn trước khi ghi");

    /* Đối chứng: mã đang hoạt động cùng khu vẫn lưu được bình thường. */
    const ok = await postJson(
      t.base,
      "/api/receipts",
      receiptBody("loc-active-0001", { data: { ...validData(), location: "B-01-04" } }),
      hdr(DEVICE_A),
    );
    assert.equal(ok.status, 201, `vị trí đang hoạt động phải lưu được: ${JSON.stringify(ok.body)}`);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
