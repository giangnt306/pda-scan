import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, hasColumn } from "../src/db.js";
import { LifecycleError } from "../src/lifecycle.js";
import { startTestApp, postJson, getJson, receiptBody, tempDataDir, recordingLogger } from "./helpers.js";

const PHASE4_COLUMNS = [
  "status",
  "sap_document_no",
  "reject_code",
  "sap_message",
  "supersedes",
  "superseded_by",
  "cancel_reason",
  "post_attempts",
];

/* Dựng lại đúng hình dạng DB THẬT hiện có: schema Phase 1, chưa từng chạy migration Phase 3,
 * đã có dữ liệu. Đây là trường hợp nguy hiểm nhất của Phase 4. */
function makeLegacyDb(dbPath, receiptCount = 2) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE images (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE recognitions (id TEXT PRIMARY KEY, image_id TEXT NOT NULL REFERENCES images(id),
      provider TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
      raw_result TEXT, normalized TEXT, error_code TEXT, error_message TEXT, duration_ms INTEGER,
      created_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE receipts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      recognition_id TEXT REFERENCES recognitions(id), image_id TEXT REFERENCES images(id),
      source TEXT NOT NULL CHECK (source IN ('camera','barcode','manual')), data TEXT NOT NULL,
      field_meta TEXT NOT NULL, payload_hash TEXT NOT NULL, client_info TEXT, created_at TEXT NOT NULL);
  `);
  const ins = db.prepare(
    "INSERT INTO receipts (id, request_id, recognition_id, image_id, source, data, field_meta, payload_hash, client_info, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  const ids = [];
  for (let i = 0; i < receiptCount; i += 1) {
    const id = crypto.randomUUID();
    ids.push(id);
    ins.run(id, `legacy-request-${i}`, null, null, "manual", JSON.stringify({ partNumber: "OLD" }), "{}", `hash-${i}`, null, `2026-09-0${i + 1}T10:00:00.000Z`);
  }
  db.close();
  return ids;
}

test("migration Phase 4: mở DB có sẵn 2 phiếu cũ → thêm đủ 8 cột, backfill status='confirmed', không mất dòng", async () => {
  const dir = tempDataDir();
  const dbPath = path.join(dir, "legacy.sqlite");
  const legacyIds = makeLegacyDb(dbPath, 2);

  const logger = recordingLogger();
  const db = openDb(dbPath, logger);
  try {
    for (const col of PHASE4_COLUMNS) {
      assert.equal(hasColumn(db, "receipts", col), true, `thiếu cột receipts.${col}`);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 2, "migration làm mất dòng receipts");
    const statuses = db.prepare("SELECT id, status, post_attempts FROM receipts ORDER BY created_at").all();
    assert.deepEqual(
      statuses.map((r) => r.status),
      ["confirmed", "confirmed"],
    );
    assert.deepEqual(
      statuses.map((r) => r.post_attempts),
      [0, 0],
    );
    assert.deepEqual(statuses.map((r) => r.id).sort(), [...legacyIds].sort());

    // Q16/L8: phiếu cũ KHÔNG được sinh job outbox và KHÔNG có sự kiện nào.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_events").get().n, 0);

    const backfill = logger.find("receipts.backfill");
    assert.equal(backfill.length, 1);
    assert.equal(backfill[0].statusFilled, 2);
    assert.equal(backfill[0].attemptsFilled, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migration idempotent: chạy openDb 3 lần liên tiếp → không lỗi, backfill lần 2 và 3 có changes = 0", async () => {
  const dir = tempDataDir();
  const dbPath = path.join(dir, "legacy.sqlite");
  makeLegacyDb(dbPath, 2);

  const logger = recordingLogger();
  const opened = [];
  try {
    for (let i = 0; i < 3; i += 1) opened.push(openDb(dbPath, logger));
    const backfill = logger.find("receipts.backfill");
    assert.equal(backfill.length, 3, "mỗi lần mở DB phải log receipts.backfill, kể cả khi changes = 0");
    assert.deepEqual(
      backfill.map((l) => l.statusFilled),
      [2, 0, 0],
    );
    assert.deepEqual(
      backfill.map((l) => l.attemptsFilled),
      [2, 0, 0],
    );
    assert.equal(opened[2].prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 2);
  } finally {
    for (const db of opened) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transition: confirmed → posting → posted ghi đúng 3 dòng receipt_events với from/to đúng", async () => {
  const t = await startTestApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-lc-transit-01"));
    const id = created.body.receiptId;
    const { lifecycle } = t.app;

    lifecycle.transition({ receiptId: id, to: "posting", event: "receipt.posting", actorKind: "system", detail: { attempt: 1 } });
    lifecycle.transition({
      receiptId: id,
      to: "posted",
      event: "receipt.posted",
      actorKind: "system",
      detail: { sapDocumentNo: "5000000001", attempt: 1 },
      patch: { sap_document_no: "5000000001", post_attempts: 1 },
    });

    const events = lifecycle.events(id);
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => [e.from, e.to, e.event]),
      [
        [null, "confirmed", "receipt.confirmed"],
        ["confirmed", "posting", "receipt.posting"],
        ["posting", "posted", "receipt.posted"],
      ],
    );
    assert.deepEqual(
      events.map((e) => e.actor.kind),
      ["device", "system", "system"],
    );
    assert.ok(events[0].id < events[1].id && events[1].id < events[2].id, "id sự kiện phải tăng dần");

    const read = await getJson(t.base, `/api/receipts/${id}`);
    assert.equal(read.body.status, "posted");
    assert.equal(read.body.sapDocumentNo, "5000000001");
    assert.equal(read.body.postAttempts, 1);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("transition cấm: rejected → posting, posted → posting, superseded → bất kỳ đâu đều ném ILLEGAL_TRANSITION và KHÔNG ghi event", async () => {
  const t = await startTestApp();
  try {
    const { lifecycle } = t.app;
    const make = async (requestId, path) => {
      const created = await postJson(t.base, "/api/receipts", receiptBody(requestId));
      const id = created.body.receiptId;
      for (const step of path) {
        lifecycle.transition({ receiptId: id, to: step, event: `receipt.${step}`, actorKind: "system" });
      }
      return id;
    };

    const rejected = await make("req-lc-forbid-01", ["posting", "rejected"]);
    const posted = await make("req-lc-forbid-02", ["posting", "posted"]);
    const superseded = await make("req-lc-forbid-03", ["superseded"]);

    const cases = [
      { id: rejected, to: "posting", from: "rejected" },
      { id: posted, to: "posting", from: "posted" },
      { id: superseded, to: "posting", from: "superseded" },
      { id: superseded, to: "cancelled", from: "superseded" },
    ];

    for (const c of cases) {
      const before = lifecycle.events(c.id).length;
      const statusBefore = lifecycle.statusOf(c.id);
      assert.throws(
        () => lifecycle.transition({ receiptId: c.id, to: c.to, event: "receipt.posting", actorKind: "system" }),
        (err) => {
          assert.ok(err instanceof LifecycleError, `${c.from} → ${c.to} phải ném LifecycleError`);
          assert.equal(err.code, "ILLEGAL_TRANSITION");
          assert.equal(err.from, c.from);
          assert.equal(err.to, c.to);
          return true;
        },
      );
      assert.equal(lifecycle.events(c.id).length, before, `${c.from} → ${c.to} không được ghi event`);
      assert.equal(lifecycle.statusOf(c.id), statusBefore, `${c.from} → ${c.to} không được đổi status`);
    }
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("transition với expectFrom không khớp → ném lỗi, status và receipt_events không đổi", async () => {
  const t = await startTestApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-lc-expect-01"));
    const id = created.body.receiptId;
    const { lifecycle } = t.app;

    const eventsBefore = lifecycle.events(id).length;
    assert.equal(lifecycle.statusOf(id), "confirmed");

    // "confirmed → posting" là hợp lệ, nhưng expectFrom nói phải đang ở "post_failed".
    assert.throws(
      () =>
        lifecycle.transition({
          receiptId: id,
          to: "posting",
          event: "receipt.posting",
          actorKind: "system",
          expectFrom: ["post_failed"],
          patch: { post_attempts: 99 },
        }),
      (err) => err instanceof LifecycleError && err.code === "ILLEGAL_TRANSITION" && err.from === "confirmed",
    );

    assert.equal(lifecycle.statusOf(id), "confirmed");
    assert.equal(lifecycle.events(id).length, eventsBefore);
    // patch cũng phải bị cuốn theo ROLLBACK, không được ghi một nửa.
    assert.equal((await getJson(t.base, `/api/receipts/${id}`)).body.postAttempts, 0);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("note(): ghi event mà không đổi status; from_state === to_state", async () => {
  const t = await startTestApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-lc-note-01"));
    const id = created.body.receiptId;
    const { lifecycle } = t.app;

    lifecycle.note({
      receiptId: id,
      event: "receipt.duplicate_override",
      actorKind: "device",
      detail: { existingReceiptId: "abc" },
    });

    assert.equal(lifecycle.statusOf(id), "confirmed", "note() không được đổi trạng thái");
    const events = lifecycle.events(id);
    assert.equal(events.length, 2);
    const noted = events[1];
    assert.equal(noted.event, "receipt.duplicate_override");
    assert.equal(noted.from, "confirmed");
    assert.equal(noted.to, "confirmed");
    assert.equal(noted.from, noted.to);
    assert.deepEqual(noted.detail, { existingReceiptId: "abc" });
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/receipts/:id/events: phiếu mới có 1 sự kiện receipt.confirmed; phiếu không tồn tại → 404 NOT_FOUND", async () => {
  const t = await startTestApp();
  try {
    const created = await postJson(t.base, "/api/receipts", receiptBody("req-lc-http-01", { source: "manual" }));
    const id = created.body.receiptId;

    const res = await getJson(t.base, `/api/receipts/${id}/events`);
    assert.equal(res.status, 200);
    assert.equal(res.body.receiptId, id);
    assert.equal(res.body.items.length, 1);
    const [first] = res.body.items;
    assert.equal(first.event, "receipt.confirmed");
    assert.equal(first.from, null, "sự kiện đầu tiên của phiếu phải có from = null");
    assert.equal(first.to, "confirmed");
    assert.equal(first.actor.kind, "device");
    assert.equal(first.detail.source, "manual");
    assert.equal(first.detail.requestId, "req-lc-http-01");
    assert.equal(first.detail.fieldsEdited, 0);
    assert.ok(typeof res.body.serverTime === "string" && res.body.serverTime.endsWith("Z"));

    const missing = await getJson(t.base, `/api/receipts/${crypto.randomUUID()}/events`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");
    assert.equal(missing.body.error.message, "Không có bản ghi này");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/receipts/:id/events: phiếu backfill (không có event nào) → 200 với items rỗng, KHÔNG phải 404", async () => {
  const t = await startTestApp();
  try {
    // Phiếu backfill = dòng receipts có status nhưng không có dòng receipt_events nào.
    const id = crypto.randomUUID();
    t.app.db
      .prepare(
        "INSERT INTO receipts (id, request_id, recognition_id, image_id, source, data, field_meta, payload_hash, client_info, created_at, status, post_attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, "req-backfilled-01", null, null, "manual", JSON.stringify({ partNumber: "OLD" }), "{}", "h", null, "2026-09-01T10:00:00.000Z", "confirmed", 0);

    const res = await getJson(t.base, `/api/receipts/${id}/events`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.receiptId, id);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
