import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, postJson, getJson, upload, receiptBody, validData, JPEG, DEVICE_A, DEVICE_B } from "./helpers.js";
import { deviceStatus, DEVICE_ONLINE_MS, DEVICE_STALE_MS } from "../src/devices.js";

let t;
before(async () => {
  t = await startTestApp();
});
after(async () => {
  await t.stop();
  t.cleanup();
});

const hdr = (deviceId) => ({ "x-device-id": deviceId });

test("POST /api/devices/register: lần đầu 201 created=true, lần hai 200 created=false, không tạo bản sao", async () => {
  const body = { deviceId: DEVICE_A, name: "PDA-01 Long Biên", appVersion: "0.2.0", network: "wifi", screen: "S3", meta: { viewport: "412x915" } };
  const first = await postJson(t.base, "/api/devices/register", body, hdr(DEVICE_A));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.created, true);
  assert.equal(first.body.device.id, DEVICE_A);
  assert.equal(first.body.device.name, "PDA-01 Long Biên");
  assert.equal(first.body.device.status, "online");
  assert.equal(first.body.heartbeatIntervalMs, 15000);
  assert.deepEqual(first.body.device.meta, { viewport: "412x915" });

  const second = await postJson(t.base, "/api/devices/register", body, hdr(DEVICE_A));
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);

  const list = await getJson(t.base, "/api/devices");
  assert.equal(list.body.items.filter((d) => d.id === DEVICE_A).length, 1);
});

test("register: thiếu deviceId ở cả header lẫn body → 400 DEVICE_REQUIRED; sai định dạng → 400 INVALID_DEVICE_ID", async () => {
  const missing = await postJson(t.base, "/api/devices/register", {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "DEVICE_REQUIRED");
  assert.equal(missing.body.error.message, "Thiếu định danh thiết bị (x-device-id)");

  const badHeader = await postJson(t.base, "/api/devices/register", {}, { "x-device-id": "KHONG-PHAI-UUID" });
  assert.equal(badHeader.status, 400);
  assert.equal(badHeader.body.error.code, "INVALID_DEVICE_ID");
  assert.equal(badHeader.body.error.details.deviceId, "KHONG-PHAI-UUID");

  // UUID v4 nhưng viết hoa: từ chối, BE không tự lowercase (Q1).
  const upper = await postJson(t.base, "/api/devices/register", {}, { "x-device-id": DEVICE_A.toUpperCase() });
  assert.equal(upper.body.error.code, "INVALID_DEVICE_ID");

  const badBody = await postJson(t.base, "/api/devices/register", { deviceId: "abc" });
  assert.equal(badBody.body.error.code, "INVALID_DEVICE_ID");
});

test("register: body.deviceId khác header x-device-id → 400 DEVICE_ID_MISMATCH", async () => {
  const r = await postJson(t.base, "/api/devices/register", { deviceId: DEVICE_B }, hdr(DEVICE_A));
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "DEVICE_ID_MISMATCH");
  assert.equal(r.body.error.details.header, DEVICE_A);
  assert.equal(r.body.error.details.pathOrBody, DEVICE_B);
});

test("register: chỉ ghi đè field có mặt trong body, field vắng giữ giá trị cũ", async () => {
  const id = "3a2b1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  await postJson(t.base, "/api/devices/register", { deviceId: id, name: "PDA-09", platform: "Android 13", network: "wifi" });
  const again = await postJson(t.base, "/api/devices/register", { deviceId: id, appVersion: "0.3.0" });
  assert.equal(again.status, 200);
  assert.equal(again.body.device.name, "PDA-09");
  assert.equal(again.body.device.platform, "Android 13");
  assert.equal(again.body.device.network, "wifi");
  assert.equal(again.body.device.appVersion, "0.3.0");

  // network ngoài enum → INVALID_BODY với details.field
  const bad = await postJson(t.base, "/api/devices/register", { deviceId: id, network: "5g" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "INVALID_BODY");
  assert.equal(bad.body.error.details.field, "network");
});

test("heartbeat: cập nhật last_seen, network, battery kẹp 0..1; device lạ → 404 DEVICE_NOT_FOUND", async () => {
  const id = "5f4e3d2c-1b0a-4987-8654-3210fedcba98";
  await postJson(t.base, "/api/devices/register", { deviceId: id, name: "PDA-HB" });
  const before = (await getJson(t.base, `/api/devices`)).body.items.find((d) => d.id === id).lastSeen;

  await new Promise((r) => setTimeout(r, 15));
  const hb = await postJson(t.base, `/api/devices/${id}/heartbeat`, { network: "cellular", battery: 5, pendingQueue: 0, screen: "S3" }, hdr(id));
  assert.equal(hb.status, 200);
  assert.equal(hb.body.ok, true);
  assert.equal(hb.body.device.network, "cellular");
  assert.equal(hb.body.heartbeatIntervalMs, 15000);
  assert.ok(hb.body.device.lastSeen > before, "heartbeat phải làm tươi last_seen");

  const row = t.app.db.prepare("SELECT battery FROM devices WHERE id = ?").get(id);
  assert.equal(row.battery, 1, "battery ngoài [0,1] bị kẹp về biên, không báo lỗi");

  const unknown = await postJson(t.base, "/api/devices/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/heartbeat", {});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "DEVICE_NOT_FOUND");
  assert.equal(unknown.body.error.message, "Thiết bị chưa đăng ký");
});

test("GET /api/devices: 2 device khác id → 2 dòng online, counts đúng", async () => {
  const t2 = await startTestApp();
  try {
    await postJson(t2.base, "/api/devices/register", { deviceId: DEVICE_A, name: "A" });
    await postJson(t2.base, "/api/devices/register", { deviceId: DEVICE_B, name: "B" });
    const { status, body } = await getJson(t2.base, "/api/devices");
    assert.equal(status, 200);
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.counts, { total: 2, online: 2, stale: 0, offline: 0 });
    for (const item of body.items) {
      assert.equal(item.status, "online");
      assert.ok(item.lastSeenAgeMs < 45000);
      assert.equal(item.activeSessionId, null);
      assert.deepEqual(item.sim, { hasOverride: false });
    }
    assert.ok(body.serverTime);
  } finally {
    await t2.stop();
    t2.cleanup();
  }
});

test("deviceStatus: < 45 s online, < 5 phút stale, còn lại offline", () => {
  const now = Date.parse("2026-09-21T14:00:00.000Z");
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(deviceStatus(at(0), now), "online");
  assert.equal(deviceStatus(at(DEVICE_ONLINE_MS - 1), now), "online");
  assert.equal(deviceStatus(at(DEVICE_ONLINE_MS), now), "stale");
  assert.equal(deviceStatus(at(DEVICE_STALE_MS - 1), now), "stale");
  assert.equal(deviceStatus(at(DEVICE_STALE_MS), now), "offline");
  assert.equal(deviceStatus(at(3_600_000), now), "offline");
});

test("request nghiệp vụ mang x-device-id lạ → tự tạo device (auto-register), nhưng GET /api/status KHÔNG cập nhật last_seen", async () => {
  const t2 = await startTestApp();
  try {
    const id = "7b6a5940-3c2d-4e1f-9a8b-7c6d5e4f3a2b";
    assert.equal((await getJson(t2.base, "/api/devices")).body.items.length, 0);

    // Đường nghiệp vụ: device chưa đăng ký vẫn được phục vụ và được tạo ngầm (Q3).
    const biz = await getJson(t2.base, "/api/receipts", hdr(id));
    assert.equal(biz.status, 200);
    const created = (await getJson(t2.base, "/api/devices")).body.items.find((d) => d.id === id);
    assert.ok(created, "request nghiệp vụ phải tự tạo dòng device");
    assert.equal(created.name, null);

    await new Promise((r) => setTimeout(r, 20));
    const st = await getJson(t2.base, "/api/status", hdr(id));
    assert.equal(st.status, 200);
    const afterStatus = (await getJson(t2.base, "/api/devices")).body.items.find((d) => d.id === id);
    assert.equal(afterStatus.lastSeen, created.lastSeen, "/api/status là đọc trạng thái, không phải dấu hiệu sống (Q4)");

    await new Promise((r) => setTimeout(r, 20));
    await getJson(t2.base, "/api/receipts", hdr(id));
    const afterBiz = (await getJson(t2.base, "/api/devices")).body.items.find((d) => d.id === id);
    assert.ok(afterBiz.lastSeen > created.lastSeen, "request nghiệp vụ phải làm tươi last_seen");
  } finally {
    await t2.stop();
    t2.cleanup();
  }
});

test("REQUIRE_DEVICE_ID=true: POST /api/recognitions và /api/receipts thiếu x-device-id → 400 DEVICE_REQUIRED", async () => {
  const t2 = await startTestApp({ requireDeviceId: true });
  try {
    const rec = await upload(t2.base, JPEG);
    assert.equal(rec.status, 400);
    assert.equal(rec.body.error.code, "DEVICE_REQUIRED");

    const save = await postJson(t2.base, "/api/receipts", receiptBody("req-needdevice-01"));
    assert.equal(save.status, 400);
    assert.equal(save.body.error.code, "DEVICE_REQUIRED");

    // Endpoint đọc không bị ràng buộc, và có header thì mọi thứ chạy bình thường.
    assert.equal((await getJson(t2.base, "/api/receipts")).status, 200);
    assert.equal((await upload(t2.base, JPEG, { headers: hdr(DEVICE_A) })).status, 201);
    assert.equal((await postJson(t2.base, "/api/receipts", receiptBody("req-needdevice-02"), hdr(DEVICE_A))).status, 201);
  } finally {
    await t2.stop();
    t2.cleanup();
  }
});

/* ═══════════════════ Phase 5 — 4 field mới cho bảng thiết bị của màn hình giám sát ═══════════ */

test("GET /api/devices trả battery, pendingQueue, session và receiptsInSession mà không mất activeSessionId", async () => {
  const t2 = await startTestApp();
  try {
    await postJson(t2.base, "/api/devices/register", { name: "PDA-A" }, hdr(DEVICE_A));
    await postJson(t2.base, "/api/devices/register", { name: "PDA-B" }, hdr(DEVICE_B));

    /* Ba con số KHÁC NHAU (0.12 / 3 / 2 phiếu): lẫn battery với pendingQueue hay với số phiếu
     * đều lộ ra ngay. battery là TỈ LỆ 0-1, không phải phần trăm (QUYẾT ĐỊNH A-7). */
    await postJson(t2.base, `/api/devices/${DEVICE_A}/heartbeat`, { battery: 0.12, pendingQueue: 3 }, hdr(DEVICE_A));

    const started = await postJson(
      t2.base,
      "/api/sessions/start",
      { operator: "Nam", warehouse: "WH01", shift: "sang" },
      hdr(DEVICE_A),
    );
    assert.equal(started.status, 201);
    const sessionId = started.body.session.id;
    for (const n of [1, 2]) {
      const saved = await postJson(t2.base, "/api/receipts", receiptBody(`req-devfields-0${n}`, { data: { ...validData(), quantity: String(70 + n) } }), {
        ...hdr(DEVICE_A),
        "x-session-id": sessionId,
      });
      assert.equal(saved.status, 201);
    }

    const { status, body } = await getJson(t2.base, "/api/devices");
    assert.equal(status, 200);
    const a = body.items.find((i) => i.id === DEVICE_A);
    const b = body.items.find((i) => i.id === DEVICE_B);

    assert.equal(a.battery, 0.12);
    assert.equal(a.pendingQueue, 3);
    assert.equal(a.receiptsInSession, 2);
    assert.deepEqual(Object.keys(a.session).sort(), ["id", "operator", "shift", "startedAt", "warehouse"]);
    assert.equal(a.session.id, sessionId);
    assert.equal(a.session.operator, "Nam");
    assert.equal(a.session.warehouse, "WH01");
    assert.equal(a.session.shift, "sang");
    assert.ok(a.session.startedAt);
    // activeSessionId của Phase 3 KHÔNG được bỏ: client cũ vẫn dùng nó.
    assert.equal(a.activeSessionId, sessionId);
    assert.deepEqual(a.sim, { hasOverride: false });

    // Thiết bị chưa heartbeat, chưa có phiên: battery null, pendingQueue 0, session null, 0 phiếu.
    assert.equal(b.battery, null);
    assert.equal(b.pendingQueue, 0);
    assert.equal(b.session, null);
    assert.equal(b.receiptsInSession, 0);
    assert.equal(b.activeSessionId, null);
  } finally {
    await t2.stop();
    t2.cleanup();
  }
});
