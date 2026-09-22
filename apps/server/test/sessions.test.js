import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, postJson, getJson, upload, receiptBody, JPEG, DEVICE_A, DEVICE_B } from "./helpers.js";

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.stop();
  t.cleanup();
});

const start = (deviceId, body = {}) => postJson(t.base, "/api/sessions/start", { deviceId, ...body }, { "x-device-id": deviceId });

test("POST /api/sessions/start: 201, session gắn đúng deviceId, summary đếm 0", async () => {
  const r = await start(DEVICE_A, { operator: "  NV-0142 Trần Văn Bình  ", warehouse: "Kho Long Biên", shift: "sang" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.session.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.body.session.deviceId, DEVICE_A);
  assert.equal(r.body.session.operator, "NV-0142 Trần Văn Bình");
  assert.equal(r.body.session.warehouse, "Kho Long Biên");
  assert.equal(r.body.session.shift, "sang");
  assert.equal(r.body.session.endedAt, null);
  assert.equal(r.body.session.endReason, null);
  assert.deepEqual(r.body.session.summary, { receipts: 0, recognitions: 0, recognitionsFailed: 0 });
  assert.equal(r.body.supersededSessionId, null);
  assert.ok(r.body.serverTime);

  // Device chưa đăng ký vẫn mở được phiên (auto-register ngầm, Q3).
  const dev = (await getJson(t.base, "/api/devices")).body.items.find((d) => d.id === DEVICE_A);
  assert.ok(dev);
  assert.equal(dev.activeSessionId, r.body.session.id);
});

test("start khi còn phiên mở → phiên cũ bị đóng end_reason=superseded, trả supersededSessionId", async () => {
  const first = await start(DEVICE_B, { operator: "Ca 1" });
  const second = await start(DEVICE_B, { operator: "Ca 2" });
  assert.equal(second.status, 201);
  assert.equal(second.body.supersededSessionId, first.body.session.id);

  const old = await getJson(t.base, `/api/sessions/${first.body.session.id}`);
  assert.equal(old.body.session.endReason, "superseded");
  assert.ok(old.body.session.endedAt);

  const fresh = await getJson(t.base, `/api/sessions/${second.body.session.id}`);
  assert.equal(fresh.body.session.endedAt, null);
});

test("POST /api/sessions/:id/end: 200; gọi lần hai → alreadyEnded=true, endedAt không đổi", async () => {
  const id = "2b7e1c44-9f3a-4d55-8e66-0a1b2c3d4e5f";
  const s = (await start(id)).body.session;
  const first = await postJson(t.base, `/api/sessions/${s.id}/end`, { reason: "manual" });
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyEnded, false);
  assert.equal(first.body.session.endReason, "manual");
  assert.ok(first.body.session.endedAt);

  const second = await postJson(t.base, `/api/sessions/${s.id}/end`, {});
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyEnded, true);
  assert.equal(second.body.session.endedAt, first.body.session.endedAt);
  assert.equal(second.body.session.endReason, "manual");
});

test("GET /api/sessions/:id: summary đếm đúng receipts / recognitions / recognitionsFailed", async () => {
  const deviceId = "9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f";
  const s = (await start(deviceId)).body.session;
  const headers = { "x-device-id": deviceId, "x-session-id": s.id };

  await upload(t.base, JPEG, { headers });
  await upload(t.base, JPEG, { query: "?sim=error", headers });
  const receipt = await postJson(t.base, "/api/receipts", receiptBody("req-session-0001"), headers);
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  assert.equal(receipt.body.deviceId, deviceId);
  assert.equal(receipt.body.sessionId, s.id);

  const read = await getJson(t.base, `/api/sessions/${s.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.session.summary, { receipts: 1, recognitions: 2, recognitionsFailed: 1 });
  assert.ok(read.body.serverTime);
});

test("session lạ → 404 SESSION_NOT_FOUND; shift ngoài enum → 400 INVALID_BODY", async () => {
  const missing = await getJson(t.base, "/api/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "SESSION_NOT_FOUND");
  assert.equal(missing.body.error.message, "Không có phiên làm việc này");

  const endMissing = await postJson(t.base, "/api/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/end", {});
  assert.equal(endMissing.status, 404);
  assert.equal(endMissing.body.error.code, "SESSION_NOT_FOUND");

  const badShift = await start(DEVICE_A, { shift: "toi" });
  assert.equal(badShift.status, 400);
  assert.equal(badShift.body.error.code, "INVALID_BODY");
  assert.equal(badShift.body.error.details.field, "shift");

  const noDevice = await postJson(t.base, "/api/sessions/start", {});
  assert.equal(noDevice.status, 400);
  assert.equal(noDevice.body.error.code, "DEVICE_REQUIRED");
});
