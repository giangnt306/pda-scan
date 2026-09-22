import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, upload, postJson, getJson, JPEG, receiptBody, tempDataDir, DEVICE_A } from "./helpers.js";
import { openDb, hasColumn } from "../src/db.js";

test("restart BE: bản ghi và ảnh vẫn đọc được; requestId cũ vẫn idempotent", async () => {
  const dataDir = tempDataDir();
  let t = await startTestApp({}, { dataDir });
  const rec = (await upload(t.base, JPEG)).body;
  const body = receiptBody("req-persist-00001", { recognitionId: rec.recognitionId, source: "camera" });
  const created = await postJson(t.base, "/api/receipts", body);
  assert.equal(created.status, 201);
  await t.stop();

  t = await startTestApp({}, { dataDir });
  try {
    const read = await getJson(t.base, `/api/receipts/${created.body.receiptId}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.data, created.body.data);

    const img = await fetch(`${t.base}${rec.image.url}`);
    assert.equal(img.status, 200);
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));

    const recAgain = await getJson(t.base, `/api/recognitions/${rec.recognitionId}`);
    assert.equal(recAgain.body.status, "completed");

    const retry = await postJson(t.base, "/api/receipts", body);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent, true);
    assert.equal((await getJson(t.base, "/api/health")).body.receipts, 1);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("migration idempotent: chạy openDb 2 lần trên DB đã có dữ liệu → không lỗi, số dòng receipts/recognitions không đổi", async () => {
  const dataDir = tempDataDir();
  const t = await startTestApp({}, { dataDir });
  const rec = (await upload(t.base, JPEG)).body;
  await postJson(t.base, "/api/receipts", receiptBody("req-migrate-00001", { recognitionId: rec.recognitionId, source: "camera" }));
  const dbPath = t.config.dbPath;
  const count = (db) => ({
    receipts: db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n,
    recognitions: db.prepare("SELECT COUNT(*) AS n FROM recognitions").get().n,
    images: db.prepare("SELECT COUNT(*) AS n FROM images").get().n,
  });
  const before = count(t.app.db);
  await t.stop();

  // Hai lần openDb liên tiếp trên cùng file: ALTER TABLE phải tự bỏ qua cột đã có.
  const first = openDb(dbPath);
  const second = openDb(dbPath);
  try {
    assert.deepEqual(count(first), before);
    assert.deepEqual(count(second), before);
    for (const col of ["device_id", "session_id"]) assert.equal(hasColumn(second, "receipts", col), true);
    for (const col of ["device_id", "session_id", "request_id"]) assert.equal(hasColumn(second, "recognitions", col), true);
    for (const table of ["devices", "sessions", "sim_state"]) {
      assert.equal(second.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n >= 0, true);
    }
  } finally {
    first.close();
    second.close();
  }

  // Dữ liệu cũ vẫn đọc lại được qua API sau khi migrate nhiều lần.
  const again = await startTestApp({}, { dataDir });
  try {
    assert.equal((await getJson(again.base, "/api/health")).body.receipts, before.receipts);
    assert.equal((await getJson(again.base, `/api/recognitions/${rec.recognitionId}`)).body.status, "completed");
  } finally {
    await again.stop();
    again.cleanup();
  }
});

test("sweep khởi động: dòng recognitions pending → failed/INTERRUPTED sau khi restart", async () => {
  const dataDir = tempDataDir();
  let t = await startTestApp({}, { dataDir });
  const rec = (await upload(t.base, JPEG)).body;
  const stuckId = "11111111-2222-4333-8444-555555555555";
  // Giả lập tiến trình bị kill giữa lúc nhận dạng: dòng pending không có ai làm tiếp.
  t.app.db
    .prepare("INSERT INTO recognitions (id, image_id, provider, status, created_at) VALUES (?, ?, 'mock', 'pending', ?)")
    .run(stuckId, rec.image.id, new Date().toISOString());
  assert.equal(t.app.db.prepare("SELECT status FROM recognitions WHERE id = ?").get(stuckId).status, "pending");
  await t.stop();

  t = await startTestApp({}, { dataDir });
  try {
    const row = t.app.db.prepare("SELECT status, error_code, error_message, finished_at FROM recognitions WHERE id = ?").get(stuckId);
    assert.equal(row.status, "failed");
    assert.equal(row.error_code, "INTERRUPTED");
    assert.equal(row.error_message, "Tiến trình BE dừng giữa lúc nhận dạng");
    assert.ok(row.finished_at);

    const read = await getJson(t.base, `/api/recognitions/${stuckId}`);
    assert.equal(read.body.status, "failed");
    assert.equal(read.body.error.code, "INTERRUPTED");
    assert.equal(read.body.fieldsFound, 0, "recognition failed thì fieldsFound là 0, không phải null");

    // Dòng đã completed không bị sweep đụng vào.
    assert.equal((await getJson(t.base, `/api/recognitions/${rec.recognitionId}`)).body.status, "completed");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("openDb chạy hai lần liên tiếp trên DB đã có dữ liệu không đổi schema và không mất dòng nào", async () => {
  const dataDir = tempDataDir();
  const t = await startTestApp({ recognitionMode: "async" }, { dataDir });
  /* Dữ liệu chạm vào ĐÚNG những thứ Phase 5 thêm vào: bảng system_events và hai cột mới của
   * recognitions. Migration idempotent nghĩa là mở lại nhiều lần không đụng tới chúng. */
  const rec = (await upload(t.base, JPEG, { headers: { "x-capture-ref": "cap-persist-0009" } })).body;
  await postJson(t.base, "/api/receipts", receiptBody("req-idem-5-0001"));
  await postJson(t.base, "/api/devices/register", { name: "PDA-A" }, { "x-device-id": DEVICE_A });
  const dbPath = t.config.dbPath;

  /* Ảnh chụp schema đầy đủ + số dòng MỌI bảng: một lần ALTER lọt lưới hay một lần DELETE nhầm
   * đều làm hai ảnh chụp khác nhau. */
  const TABLES = ["images", "recognitions", "receipts", "devices", "sessions", "sim_state", "receipt_events", "outbox", "system_events"];
  const snapshot = (db) => ({
    columns: Object.fromEntries(
      TABLES.map((tb) => [tb, db.prepare(`PRAGMA table_info(${tb})`).all().map((c) => `${c.name}:${c.type}`).join(",")]),
    ),
    rows: Object.fromEntries(TABLES.map((tb) => [tb, db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n])),
  });

  const before = snapshot(t.app.db);
  assert.ok(before.rows.system_events >= 3, "phải có sẵn dòng system_events để phép kiểm có nghĩa");
  assert.ok(before.columns.recognitions.includes("mode:TEXT"));
  assert.ok(before.columns.recognitions.includes("capture_ref:TEXT"));
  await t.stop();

  const first = openDb(dbPath);
  const second = openDb(dbPath);
  try {
    assert.deepEqual(snapshot(first), before, "lần mở thứ nhất không được đổi schema hay mất dòng");
    assert.deepEqual(snapshot(second), before, "lần mở thứ hai cũng vậy — migration phải idempotent");
    for (const col of ["mode", "capture_ref"]) assert.equal(hasColumn(second, "recognitions", col), true);
    // Giá trị Phase 5 của dòng cũ còn nguyên sau hai lần migrate.
    const row = second.prepare("SELECT mode, capture_ref FROM recognitions WHERE id = ?").get(rec.recognitionId);
    assert.equal(row.mode, "async");
    assert.equal(row.capture_ref, "cap-persist-0009");
  } finally {
    first.close();
    second.close();
  }

  const again = await startTestApp({ recognitionMode: "async" }, { dataDir });
  try {
    // Mở lại bằng app thật: sweep khởi động ghi thêm server.start nên số dòng CHỈ tăng, không mất.
    const after = snapshot(again.app.db);
    assert.deepEqual(after.columns, before.columns);
    for (const tb of TABLES) {
      assert.ok(after.rows[tb] >= before.rows[tb], `bảng ${tb} bị mất dòng sau khi mở lại`);
    }
    assert.equal(after.rows.receipts, before.rows.receipts);
    assert.equal(after.rows.recognitions, before.rows.recognitions);
  } finally {
    await again.stop();
    again.cleanup();
  }
});
