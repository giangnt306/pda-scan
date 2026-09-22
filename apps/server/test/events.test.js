import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createEventLog, EVENT_TYPES, CLIENT_EVENT_TYPES, SEVERITIES, DETAIL_MAX_BYTES } from "../src/events.js";
import { startTestApp, postJson, receiptBody, recordingLogger } from "./helpers.js";

/* Sổ sự kiện chạy trên DB trong bộ nhớ: không đụng đĩa, không đụng apps/server/data/. */
function makeLog({ events = {}, logger = null } = {}) {
  const db = openDb(":memory:");
  const config = { events: { enabled: true, maxRows: 2000, trimEvery: 100, mirrorReceipts: true, ...events } };
  return { db, log: createEventLog({ db, config, logger }) };
}

/* Ghi n dòng, mỗi dòng mang đúng chỉ số của nó trong detail.i — nhờ đó một lỗi lệch chỉ số
 * (off-by-one) trong phép phân trang lộ ra ngay, thay vì chìm trong n dòng giống hệt nhau. */
function seed(log, n, type = "device.battery_low") {
  for (let i = 1; i <= n; i += 1) log.write({ type, detail: { i } });
}

const idsOf = (res) => res.items.map((e) => e.id);
const marksOf = (res) => res.items.map((e) => e.detail.i);

test("EVENT_TYPES có đúng 31 loại và mọi severity thuộc {info, warn, error}", () => {
  const types = Object.keys(EVENT_TYPES);
  assert.equal(types.length, 31);
  // 16 loại cố định + 15 loại receipt.* (02-contracts-api.md §4.3).
  assert.equal(types.filter((t) => t.startsWith("receipt.")).length, 15);
  assert.equal(types.filter((t) => !t.startsWith("receipt.")).length, 16);
  for (const [type, severity] of Object.entries(EVENT_TYPES)) {
    assert.ok(SEVERITIES.includes(severity), `severity lạ cho ${type}: ${severity}`);
  }
  // 5 loại PDA được gửi lên đều phải nằm trong bảng đăng ký, và session.started thì KHÔNG.
  assert.equal(CLIENT_EVENT_TYPES.length, 5);
  for (const t of CLIENT_EVENT_TYPES) assert.ok(Object.hasOwn(EVENT_TYPES, t), `${t} không có trong EVENT_TYPES`);
  assert.equal(CLIENT_EVENT_TYPES.includes("session.started"), false);
});

test("events.write ném Error khi type không có trong EVENT_TYPES", () => {
  const { db, log } = makeLog();
  try {
    assert.throws(() => log.write({ type: "receipt.exploded" }), /receipt\.exploded/);
    assert.throws(() => log.write({ type: undefined }), /EVENT_TYPES/);
    // Ném chứ KHÔNG ghi im lặng: bảng phải còn rỗng sau hai lần ném.
    assert.equal(log.count(), 0);
    // Đối chứng: một type hợp lệ thì ghi được — chứng minh write() không phải lúc nào cũng ném.
    assert.equal(typeof log.write({ type: "server.start", detail: {} }), "number");
    assert.equal(log.count(), 1);
  } finally {
    db.close();
  }
});

test("events.write suy severity từ EVENT_TYPES khi caller không truyền", () => {
  const { db, log } = makeLog();
  try {
    /* Ba type có ba severity KHÁC NHAU: nếu code trả cứng "info" thì hai dòng dưới sẽ sai. */
    log.write({ type: "recognition.failed", detail: { code: "RECOGNITION_TIMEOUT" } });
    log.write({ type: "sim.updated", detail: { scope: "global" } });
    log.write({ type: "session.started", detail: { operator: "Nam" } });
    /* node:sqlite trả object null-prototype → nắn về object thường trước khi deepEqual. */
    const rows = db
      .prepare("SELECT type, severity FROM system_events ORDER BY id ASC")
      .all()
      .map((r) => ({ type: r.type, severity: r.severity }));
    assert.deepEqual(rows, [
      { type: "recognition.failed", severity: "error" },
      { type: "sim.updated", severity: "warn" },
      { type: "session.started", severity: "info" },
    ]);
    // severity lạ do caller truyền tay thì ném, không âm thầm ghi.
    assert.throws(() => log.write({ type: "server.start", severity: "fatal" }), /severity/);
  } finally {
    db.close();
  }
});

test("events.write nuốt lỗi DB và ghi logger.warn thay vì ném ra ngoài", () => {
  const logger = recordingLogger();
  const { db, log } = makeLog({ logger });
  try {
    assert.equal(log.count(), 0);
    // Làm hỏng tầng lưu trữ ngay dưới chân sổ sự kiện (chỉ trong DB bộ nhớ của test này).
    db.exec("DROP TABLE system_events");
    assert.doesNotThrow(() => log.write({ type: "device.queue_synced", detail: { synced: 3 } }));
    const warns = logger.find("events.write_failed");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].level, "warn");
    assert.equal(warns[0].type, "device.queue_synced");
    assert.ok(warns[0].error, "phải kèm thông điệp lỗi gốc để còn gỡ được");
  } finally {
    db.close();
  }
});

test("detail lớn hơn 2048 byte bị thay bằng { _truncated: true }", () => {
  const { db, log } = makeLog();
  try {
    const huge = { blob: "đ".repeat(DETAIL_MAX_BYTES) }; // "đ" = 2 byte UTF-8 → chắc chắn vượt trần
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) > DETAIL_MAX_BYTES);
    log.write({ type: "device.sim_changed", detail: huge });
    // Sát ngưỡng nhưng KHÔNG vượt thì phải giữ nguyên — nếu không, test trên vô nghĩa.
    const small = { blob: "a".repeat(100) };
    log.write({ type: "device.sim_changed", detail: small });
    // detail không phải object → {} (không phải _truncated).
    log.write({ type: "device.sim_changed", detail: "một chuỗi" });

    const rows = db.prepare("SELECT detail FROM system_events ORDER BY id ASC").all().map((r) => JSON.parse(r.detail));
    assert.deepEqual(rows[0], { _truncated: true });
    assert.deepEqual(rows[1], small);
    assert.deepEqual(rows[2], {});
  } finally {
    db.close();
  }
});

test("EVENTS_ENABLED=false làm write là no-op và list trả items rỗng với lastId bằng since", () => {
  const { db, log } = makeLog({ events: { enabled: false } });
  try {
    assert.equal(log.write({ type: "server.start", detail: {} }), null);
    assert.equal(log.writeMany([{ type: "device.battery_low", detail: { level: 0.1 } }]), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_events").get().n, 0);

    const res = log.list({ since: 41, limit: 10 });
    assert.deepEqual(res.items, []);
    assert.equal(res.lastId, 41, "tắt sổ sự kiện vẫn phải trả về đúng con trỏ client gửi");
    assert.equal(res.hasMore, false);
  } finally {
    db.close();
  }
});

test("cắt vòng xoay giữ đúng EVENTS_MAX_ROWS dòng sau khi vượt ngưỡng", () => {
  /* Ba hằng số KHÁC NHAU (7 / 5 / 20): nếu code lẫn maxRows với trimEvery hay với số lần ghi
   * thì con số cuối cùng sẽ khác 7 ngay. */
  const { db, log } = makeLog({ events: { maxRows: 7, trimEvery: 5 } });
  try {
    seed(log, 20);
    assert.equal(log.writeCount(), 20);
    assert.equal(log.count(), 7, "vòng xoay phải giữ đúng maxRows dòng");
    const range = db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM system_events").get();
    // Giữ 7 dòng MỚI NHẤT (14..20), không phải 7 dòng cũ nhất.
    assert.equal(range.lo, 14, "dòng cũ nhất còn lại phải là 14");
    assert.equal(range.hi, 20, "dòng mới nhất phải được giữ nguyên");
    assert.deepEqual(
      db.prepare("SELECT detail FROM system_events ORDER BY id ASC").all().map((r) => JSON.parse(r.detail).i),
      [14, 15, 16, 17, 18, 19, 20],
    );
  } finally {
    db.close();
  }
});

test("list trả oldestId = MIN(id) thật sau khi vòng xoay đã cắt, đủ để tính ra 13 dòng đã mất", () => {
  const { db, log } = makeLog({ events: { maxRows: 7, trimEvery: 5 } });
  try {
    seed(log, 20); // vòng xoay giữ 14..20, xoá hẳn 1..13
    const real = db.prepare("SELECT MIN(id) AS lo FROM system_events").get().lo;
    assert.equal(real, 14, "tiền đề của test: bảng chỉ còn từ id 14");

    /* Người đọc tạm dừng ở con trỏ 3 rồi quay lại: các dòng 4..13 đã bị DELETE. */
    const res = log.list({ since: 3, limit: 50 });
    assert.equal(res.oldestId, 14, "oldestId phải là MIN(id) THẬT của bảng, không phải 0 hay since");
    assert.deepEqual(idsOf(res), [14, 15, 16, 17, 18, 19, 20]);
    assert.equal(res.oldestId - 3 - 1, 10, "oldestId + since đủ để đếm 10 dòng (4..13) đã mất hẳn");

    /* Người đọc THEO KỊP: cùng một bảng, cùng một oldestId, nhưng không có dòng nào mất. */
    const caughtUp = log.list({ since: 15, limit: 50 });
    assert.equal(caughtUp.oldestId, 14);
    assert.ok(caughtUp.oldestId - 15 - 1 < 0, "con trỏ còn nằm trong vùng bảng giữ được thì hiệu phải âm");
  } finally {
    db.close();
  }
});

test("list trả oldestId = 0 khi bảng rỗng và khi EVENTS_ENABLED=false — không có gì để khẳng định", () => {
  const empty = makeLog();
  try {
    assert.equal(empty.log.count(), 0);
    assert.equal(empty.log.list({ since: 5, limit: 10 }).oldestId, 0, "bảng rỗng: 0 nghĩa là không kết luận");
  } finally {
    empty.db.close();
  }

  const off = makeLog({ events: { enabled: false } });
  try {
    off.log.write({ type: "server.start", detail: {} });
    const res = off.log.list({ since: 41, limit: 10 });
    assert.equal(res.oldestId, 0, "tắt sổ sự kiện thì không được bịa ra một mốc cũ nhất");
    assert.equal(res.lastId, 41, "hành vi cũ của nhánh tắt vẫn nguyên vẹn");
  } finally {
    off.db.close();
  }
});

test("oldestId là MIN của CẢ BẢNG, không đổi khi lọc theo type/severity/deviceId", () => {
  const { db, log } = makeLog();
  try {
    /* Dòng 1 là type/severity KHÁC hẳn phần còn lại: nếu MIN bị áp bộ lọc thì oldestId của
     * truy vấn có lọc sẽ nhảy lên 2, và client sẽ tưởng dòng 1 đã bị vòng xoay cắt. */
    log.write({ type: "server.start", detail: { i: 1 } });
    seed(log, 4); // id 2..5, type device.battery_low (severity warn)

    assert.equal(log.list({ since: 1, limit: 50 }).oldestId, 1);
    assert.equal(log.list({ since: 1, limit: 50, types: ["device.battery_low"] }).oldestId, 1, "lọc type không được đẩy oldestId lên");
    assert.equal(log.list({ since: 1, limit: 50, severity: "warn" }).oldestId, 1, "lọc severity không được đẩy oldestId lên");
    assert.equal(
      log.list({ since: 1, limit: 50, deviceId: "0d5c7f33-9d59-4d2e-8f11-0b3c9c0bd511" }).oldestId,
      1,
      "lọc deviceId không được đẩy oldestId lên",
    );
    // Tiền đề: bộ lọc THẬT SỰ có tác dụng lên items, nên ba khẳng định trên không phải là chuyện hiển nhiên.
    assert.deepEqual(idsOf(log.list({ since: 0, limit: 50, types: ["device.battery_low"] })), [2, 3, 4, 5]);
  } finally {
    db.close();
  }
});

test("list({since:0}) trả limit dòng MỚI NHẤT, sắp xếp id tăng dần", () => {
  const { db, log } = makeLog();
  try {
    seed(log, 9);
    const res = log.list({ since: 0, limit: 4 });
    assert.deepEqual(idsOf(res), [6, 7, 8, 9], "since=0 phải trả 4 dòng MỚI NHẤT");
    assert.deepEqual(marksOf(res), [6, 7, 8, 9]);
    assert.equal(res.lastId, 9);
  } finally {
    db.close();
  }
});

test("list({since:N}) chỉ trả dòng có id > N, sắp xếp id tăng dần", () => {
  const { db, log } = makeLog();
  try {
    seed(log, 9);
    const res = log.list({ since: 6, limit: 2 });
    assert.deepEqual(idsOf(res), [7, 8], "phải bắt đầu từ id 7, không bao gồm chính dòng 6");
    assert.deepEqual(marksOf(res), [7, 8]);
    assert.equal(res.lastId, 8);
  } finally {
    db.close();
  }
});

test("list trả lastId bằng since khi không có dòng mới, KHÔNG phải 0", () => {
  const { db, log } = makeLog();
  try {
    seed(log, 9);
    const res = log.list({ since: 9, limit: 50 });
    assert.deepEqual(res.items, []);
    assert.equal(res.lastId, 9, "trả 0 sẽ làm monitor tải lại dòng sự kiện từ đầu mỗi 3 giây");
    assert.equal(res.hasMore, false);
    // Con trỏ vượt quá cả dòng cuối cùng cũng phải được giữ nguyên.
    assert.equal(log.list({ since: 12345, limit: 50 }).lastId, 12345);
  } finally {
    db.close();
  }
});

test("list trả hasMore=true khi còn dòng vượt limit và false khi đã hết", () => {
  const { db, log } = makeLog();
  try {
    seed(log, 9);
    const page1 = log.list({ since: 2, limit: 3 });
    assert.deepEqual(idsOf(page1), [3, 4, 5]);
    assert.equal(page1.hasMore, true, "còn dòng 6..9 nên hasMore phải là true");

    const page2 = log.list({ since: page1.lastId, limit: 9 });
    assert.deepEqual(idsOf(page2), [6, 7, 8, 9]);
    assert.equal(page2.hasMore, false, "đã lấy tới dòng cuối thì hasMore phải là false");
  } finally {
    db.close();
  }
});

test("lifecycle.transition ghi gương một dòng system_events với đúng type, receiptId và detail", async () => {
  const t = await startTestApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-mirror-00001"));
    assert.equal(created.status, 201);
    const receiptId = created.body.receiptId;

    const mirrored = t.app.db
      .prepare("SELECT type, severity, receipt_id, detail FROM system_events WHERE receipt_id = ? ORDER BY id ASC")
      .all(receiptId);
    assert.equal(mirrored.length, 1, "một lần đổi trạng thái ghi gương ĐÚNG MỘT dòng");
    assert.equal(mirrored[0].type, "receipt.confirmed");
    assert.equal(mirrored[0].severity, EVENT_TYPES["receipt.confirmed"]);
    assert.equal(mirrored[0].receipt_id, receiptId);

    // detail y nguyên detail của receipt_events (không bịa thêm, không bỏ bớt).
    const origin = t.app.db
      .prepare("SELECT event, detail FROM receipt_events WHERE receipt_id = ? ORDER BY id ASC")
      .all(receiptId);
    assert.equal(origin.length, 1);
    assert.equal(mirrored[0].type, origin[0].event);
    assert.deepEqual(JSON.parse(mirrored[0].detail), JSON.parse(origin[0].detail));
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("EVENTS_MIRROR_RECEIPTS=false tắt ghi gương nhưng receipt_events vẫn được ghi đầy đủ", async () => {
  const t = await startTestApp({ events: { mirrorReceipts: false } });
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-nomirror-0001"));
    assert.equal(created.status, 201);
    const receiptId = created.body.receiptId;

    // Sổ kiểm toán Phase 4 KHÔNG được đụng tới: nó là chỉ-INSERT vĩnh viễn.
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM receipt_events WHERE receipt_id = ?").get(receiptId).n, 1);
    // Dòng sự kiện Phase 5 thì không có bản gương nào.
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM system_events WHERE receipt_id = ?").get(receiptId).n, 0);
    // Nhưng sổ sự kiện vẫn sống: server.start vẫn được ghi, tắt gương không phải tắt cả sổ.
    assert.ok(t.app.db.prepare("SELECT COUNT(*) AS n FROM system_events WHERE type = 'server.start'").get().n >= 1);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
