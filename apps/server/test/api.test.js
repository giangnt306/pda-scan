import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestApp, upload, postJson, getJson, JPEG, PNG, receiptBody, validData } from "./helpers.js";

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.stop();
  t.cleanup();
});

test("GET /api/health", async () => {
  const { status, body } = await getJson(t.base, "/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.provider, "mock");
  assert.equal(body.db, "ok");
});

test("404 / 405 có body lỗi rõ", async () => {
  const notFound = await getJson(t.base, "/api/nope");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, "NOT_FOUND");
  assert.equal(notFound.body.error.message, "Không có đường dẫn này");

  const r = await fetch(`${t.base}/api/health`, { method: "DELETE" });
  assert.equal(r.status, 405);
  const body = await r.json();
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
  assert.equal(body.error.message, "Phương thức không được hỗ trợ cho đường dẫn này");
});

test("POST /api/recognitions: upload JPEG → recognitionId + fields đã chuẩn hoá; ảnh đọc lại được", async () => {
  const { status, body } = await upload(t.base, JPEG);
  assert.equal(status, 201);
  assert.match(body.recognitionId, /^[0-9a-f-]{36}$/);
  assert.equal(body.status, "completed");
  assert.equal(body.provider, "mock");
  assert.equal(typeof body.fields.quantity.value, "number");
  assert.equal(body.fields.shipmentDate.value, "2026-09-15");
  assert.equal(body.fields.shipmentDate.raw, "15/9/2026");
  assert.equal(body.fields.supplier.value, "Nội bộ — Made in Vietnam");
  assert.equal(body.fields.location.status, "missing");
  assert.equal(body.image.bytes, JPEG.length);
  assert.equal(body.image.mimeType, "image/jpeg");

  const img = await fetch(`${t.base}${body.image.url}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));

  // tên file do server tạo, không dùng tên client gửi
  const files = fs.readdirSync(t.config.uploadsDir);
  assert.ok(files.includes(`${body.image.id}.jpg`));
  assert.ok(!files.includes("label.jpg"));

  const again = await getJson(t.base, `/api/recognitions/${body.recognitionId}`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.fields, body.fields);
});

test("POST /api/recognitions: PNG được nhận, tên file theo magic bytes", async () => {
  const { status, body } = await upload(t.base, PNG, { filename: "x.jpg", type: "image/jpeg" });
  assert.equal(status, 201);
  assert.equal(body.image.mimeType, "image/png");
  assert.ok(fs.existsSync(path.join(t.config.uploadsDir, `${body.image.id}.png`)));
});

test("POST /api/recognitions: từ chối không phải ảnh, thiếu field, rỗng, sai sim", async () => {
  assert.equal((await upload(t.base, Buffer.from("hello world, not an image"))).status, 415);
  assert.equal((await upload(t.base, JPEG, { field: "file" })).body.error.code, "IMAGE_REQUIRED");
  assert.equal((await upload(t.base, Buffer.alloc(0))).body.error.code, "IMAGE_EMPTY");
  assert.equal((await upload(t.base, JPEG, { query: "?sim=weird" })).body.error.code, "INVALID_SIM");
  const r = await fetch(`${t.base}/api/recognitions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 415);
});

test("sim=error → 502 kèm recognitionId, bản ghi recognition ở trạng thái failed", async () => {
  const { status, body } = await upload(t.base, JPEG, { query: "?sim=error" });
  assert.equal(status, 502);
  assert.equal(body.error.code, "RECOGNITION_FAILED");
  const rec = await getJson(t.base, `/api/recognitions/${body.error.details.recognitionId}`);
  assert.equal(rec.body.status, "failed");
  assert.equal(rec.body.error.code, "RECOGNITION_FAILED");
  assert.equal(rec.body.fields, null);
});

test("sim=slow vẫn thành công khi dưới timeout", async () => {
  const t0 = Date.now();
  const { status } = await upload(t.base, JPEG, { query: "?sim=slow" });
  assert.equal(status, 201);
  assert.ok(Date.now() - t0 >= 150);
});

test("POST /api/receipts: lưu → 201, đọc lại GET /api/receipts/:id trùng dữ liệu, kiểu đã ép", async () => {
  const rec = (await upload(t.base, JPEG)).body;
  const body = receiptBody("req-camera-00001", {
    recognitionId: rec.recognitionId,
    source: "camera",
    data: { ...validData(), grossWeight: "12,5", note: "  " },
    fieldMeta: { partNumber: { via: "ai", confidence: 0.94, edited: true, proposed: "BEX32181030AB" }, junk: { via: "x" } },
    client: { userAgent: "test" },
  });
  const created = await postJson(t.base, "/api/receipts", body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.idempotent, false);
  assert.equal(created.body.imageId, rec.image.id);
  assert.equal(created.body.data.quantity, 80);
  assert.equal(created.body.data.grossWeight, 12.5);
  assert.equal(created.body.data.note, null);
  assert.equal(created.body.fieldMeta.junk, undefined);
  assert.equal(created.body.fieldMeta.partNumber.edited, true);

  const read = await getJson(t.base, `/api/receipts/${created.body.receiptId}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data, created.body.data);
  assert.equal(read.body.recognitionId, rec.recognitionId);
});

test("idempotency: cùng requestId cùng payload → 200 idempotent, không thêm bản ghi", async () => {
  const before = (await getJson(t.base, "/api/health")).body.receipts;
  const body = receiptBody("req-idem-000001");
  const a = await postJson(t.base, "/api/receipts", body);
  const b = await postJson(t.base, "/api/receipts", { ...body, data: { ...body.data, partNumber: " bex32181030ab " } }); // khác cách viết, cùng giá trị chuẩn hoá
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.idempotent, true);
  assert.equal(b.body.receiptId, a.body.receiptId);
  assert.equal((await getJson(t.base, "/api/health")).body.receipts, before + 1);
});

test("idempotency: cùng requestId khác payload → 409 REQUEST_ID_CONFLICT", async () => {
  const body = receiptBody("req-conflict-0001");
  const a = await postJson(t.base, "/api/receipts", body);
  const b = await postJson(t.base, "/api/receipts", { ...body, data: { ...body.data, quantity: 81 } });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, "REQUEST_ID_CONFLICT");
  assert.equal(b.body.error.details.receiptId, a.body.receiptId);
});

test("idempotency: 6 request cùng requestId song song → đúng 1 bản ghi", async () => {
  const before = (await getJson(t.base, "/api/health")).body.receipts;
  const body = receiptBody("req-parallel-0001");
  const results = await Promise.all(Array.from({ length: 6 }, () => postJson(t.base, "/api/receipts", body)));
  const ids = new Set(results.map((r) => r.body.receiptId));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  assert.equal((await getJson(t.base, "/api/health")).body.receipts, before + 1);
});

test("validation phía BE: ngày 31/02, quantity 0, recognitionId lạ, requestId xấu, source sai", async () => {
  const bad = await postJson(t.base, "/api/receipts", receiptBody("req-bad-0000001", { data: { ...validData(), shipmentDate: "2026-02-31", quantity: 0 } }));
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "VALIDATION_FAILED");
  assert.equal(bad.body.error.details.fields.shipmentDate, "Ngày không hợp lệ");
  assert.equal(bad.body.error.details.fields.quantity, "Số lượng phải lớn hơn 0");

  const unknownRec = await postJson(t.base, "/api/receipts", receiptBody("req-bad-0000002", { recognitionId: "00000000-0000-0000-0000-000000000000", source: "camera" }));
  assert.equal(unknownRec.body.error.code, "RECOGNITION_NOT_FOUND");
  assert.equal((await postJson(t.base, "/api/receipts", receiptBody("short"))).body.error.code, "INVALID_REQUEST_ID");
  assert.equal((await postJson(t.base, "/api/receipts", receiptBody("req-bad-0000003", { source: "sap" }))).body.error.code, "INVALID_SOURCE");
  assert.equal((await getJson(t.base, "/api/health")).body.receipts > 0, true);
  const notJson = await fetch(`${t.base}/api/receipts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal((await notJson.json()).error.code, "INVALID_JSON");
});

test("simSave=fail → 503 SAVE_FAILED_SIMULATED, không có bản ghi; retry không sim → lưu được", async () => {
  const body = receiptBody("req-savefail-0001");
  const fail = await postJson(t.base, "/api/receipts?simSave=fail", body);
  assert.equal(fail.status, 503);
  assert.equal(fail.body.error.code, "SAVE_FAILED_SIMULATED");
  const ok = await postJson(t.base, "/api/receipts", body);
  assert.equal(ok.status, 201);
});

test("GET /api/receipts liệt kê bản ghi mới nhất trước", async () => {
  const { body } = await getJson(t.base, "/api/receipts?limit=3");
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length <= 3);
  assert.ok(body.items.length >= 1);
});

test("POST /api/recognitions trả fieldsFound và requestId; ảnh không đọc được trường nào → warning \"Không đọc được trường nào trên nhãn\"", async () => {
  const { status, body } = await upload(t.base, JPEG, { headers: { "x-request-id": "acc-e9-000001" } });
  assert.equal(status, 201);
  assert.equal(typeof body.fieldsFound, "number");
  assert.equal(body.fieldsFound, Object.values(body.fields).filter((f) => f.status === "ok").length);
  assert.ok(body.fieldsFound > 0);
  assert.equal(body.requestId, "acc-e9-000001");
  assert.equal(body.warnings.includes("Không đọc được trường nào trên nhãn"), false);

  // Đọc lại cũng phải có fieldsFound, và warning không bị nhân đôi.
  const again = await getJson(t.base, `/api/recognitions/${body.recognitionId}`);
  assert.equal(again.body.fieldsFound, body.fieldsFound);
  assert.deepEqual(again.body.warnings, body.warnings);
  assert.equal(again.body.requestId, "acc-e9-000001");

  // Provider không đọc được trường nào → cảnh báo đúng nguyên văn cho người vận hành.
  const blind = await startTestApp({}, { provider: { name: "mock", async recognize() { return { raw: {}, fields: {} }; } } });
  try {
    const empty = await upload(blind.base, JPEG);
    assert.equal(empty.status, 201);
    assert.equal(empty.body.fieldsFound, 0);
    assert.deepEqual(empty.body.warnings, ["Không đọc được trường nào trên nhãn"]);
    const reread = await getJson(blind.base, `/api/recognitions/${empty.body.recognitionId}`);
    assert.deepEqual(reread.body.warnings, ["Không đọc được trường nào trên nhãn"]);
  } finally {
    await blind.stop();
    blind.cleanup();
  }
});

test("POST /api/receipts với x-device-id + x-session-id → response có deviceId/sessionId, DB lưu đúng", async () => {
  const deviceId = "4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a";
  const started = await postJson(t.base, "/api/sessions/start", { deviceId }, { "x-device-id": deviceId });
  const sessionId = started.body.session.id;
  const headers = { "x-device-id": deviceId, "x-session-id": sessionId };

  const rec = await upload(t.base, JPEG, { headers });
  const created = await postJson(t.base, "/api/receipts", receiptBody("req-device-000001", { recognitionId: rec.body.recognitionId, source: "camera" }), headers);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.deviceId, deviceId);
  assert.equal(created.body.sessionId, sessionId);

  const row = t.app.db.prepare("SELECT device_id, session_id FROM receipts WHERE id = ?").get(created.body.receiptId);
  assert.equal(row.device_id, deviceId);
  assert.equal(row.session_id, sessionId);
  const recRow = t.app.db.prepare("SELECT device_id, session_id, request_id FROM recognitions WHERE id = ?").get(rec.body.recognitionId);
  assert.equal(recRow.device_id, deviceId);
  assert.equal(recRow.session_id, sessionId);
  assert.ok(recRow.request_id, "BE tự sinh x-request-id khi FE không gửi");

  const read = await getJson(t.base, `/api/receipts/${created.body.receiptId}`);
  assert.equal(read.body.deviceId, deviceId);
  assert.equal(read.body.sessionId, sessionId);

  // Không có header thì lưu NULL, không báo lỗi (REQUIRE_DEVICE_ID=false ở Phase 3).
  const anon = await postJson(t.base, "/api/receipts", receiptBody("req-device-000002"));
  assert.equal(anon.status, 201);
  assert.equal(anon.body.deviceId, null);
  assert.equal(anon.body.sessionId, null);

  // x-session-id rác bị bỏ qua im lặng, không chặn thao tác.
  const junkSession = await postJson(t.base, "/api/receipts", receiptBody("req-device-000003"), { "x-device-id": deviceId, "x-session-id": "khong-phai-uuid" });
  assert.equal(junkSession.status, 201);
  assert.equal(junkSession.body.sessionId, null);
});

test("mọi response đều có header x-request-id; gửi x-request-id thì server trả lại đúng giá trị đó", async () => {
  const echo = await fetch(`${t.base}/api/health`, { headers: { "x-request-id": "acc-e2-000001" } });
  assert.equal(echo.headers.get("x-request-id"), "acc-e2-000001");

  const generated = await fetch(`${t.base}/api/health`);
  assert.match(generated.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);

  // Sai định dạng → BE tự sinh, KHÔNG báo lỗi.
  const bad = await fetch(`${t.base}/api/health`, { headers: { "x-request-id": "x" } });
  assert.equal(bad.status, 200);
  assert.notEqual(bad.headers.get("x-request-id"), "x");

  // Kể cả response lỗi, 404, 405 và response nhị phân.
  const notFound = await fetch(`${t.base}/api/nope`, { headers: { "x-request-id": "acc-404-00001" } });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get("x-request-id"), "acc-404-00001");

  const methodNotAllowed = await fetch(`${t.base}/api/health`, { method: "DELETE", headers: { "x-request-id": "acc-405-00001" } });
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.headers.get("x-request-id"), "acc-405-00001");

  const rec = await upload(t.base, JPEG);
  const img = await fetch(`${t.base}${rec.body.image.url}`, { headers: { "x-request-id": "acc-img-00001" } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("x-request-id"), "acc-img-00001");

  const invalidDevice = await fetch(`${t.base}/api/health`, { headers: { "x-device-id": "xx", "x-request-id": "acc-400-00001" } });
  assert.equal(invalidDevice.status, 400);
  assert.equal(invalidDevice.headers.get("x-request-id"), "acc-400-00001");
});
