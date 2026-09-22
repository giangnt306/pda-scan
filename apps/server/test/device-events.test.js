import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, postJson, putJson, delJson, getJson, DEVICE_A, DEVICE_B } from "./helpers.js";
import { CLIENT_EVENT_TYPES } from "../src/events.js";

/* POST /api/devices/:deviceId/events — endpoint GHI mới duy nhất ngoài /api/admin/ (§4.5).
 * Validate CẢ LÔ trước khi ghi: một phần tử sai → 400 và KHÔNG ghi phần tử nào (QUYẾT ĐỊNH A-9). */

const UNKNOWN_DEVICE = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

async function appWithDevice(overrides = {}) {
  const t = await startTestApp(overrides);
  const reg = await postJson(t.base, "/api/devices/register", { name: "PDA-A" }, { "x-device-id": DEVICE_A });
  assert.equal(reg.status, 201);
  return t;
}

const countEvents = (t, deviceId) =>
  t.app.db.prepare("SELECT COUNT(*) AS n FROM system_events WHERE device_id = ?").get(deviceId).n;

const send = (t, deviceId, body, headers = {}) =>
  postJson(t.base, `/api/devices/${deviceId}/events`, body, { "x-device-id": deviceId, ...headers });

test("POST /api/devices/:id/events trả 202 với accepted đúng bằng số phần tử đã ghi", async () => {
  const t = await appWithDevice();
  try {
    const before = countEvents(t, DEVICE_A);
    /* 3 phần tử, 3 loại KHÁC NHAU: nếu code ghi nhầm một loại cho cả lô thì lộ ra. */
    const res = await send(t, DEVICE_A, {
      events: [
        { type: "device.camera_error", detail: { name: "NotAllowedError" } },
        { type: "device.queue_enqueued", detail: { reason: "OFFLINE", size: 3 } },
        { type: "device.battery_low", detail: { level: 0.12 } },
      ],
    });
    assert.equal(res.status, 202, "202 vì sự kiện chỉ là quan sát, không tạo tài nguyên client tham chiếu lại");
    assert.equal(res.body.accepted, 3);
    assert.equal(res.body.rejected, 0);
    assert.match(res.body.serverTime, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(countEvents(t, DEVICE_A) - before, 3, "accepted phải khớp SỐ DÒNG thật sự ghi xuống DB");

    const rows = t.app.db
      .prepare("SELECT type, severity, detail FROM system_events WHERE device_id = ? ORDER BY id DESC LIMIT 3")
      .all(DEVICE_A);
    assert.deepEqual(rows.map((r) => r.type).sort(), ["device.battery_low", "device.camera_error", "device.queue_enqueued"]);
    // severity suy từ bảng đăng ký, cả ba loại này đều là "warn".
    assert.deepEqual([...new Set(rows.map((r) => r.severity))], ["warn"]);
    const battery = rows.find((r) => r.type === "device.battery_low");
    assert.deepEqual(JSON.parse(battery.detail), { level: 0.12 });

    // Lô một phần tử cũng hợp lệ (biên dưới 1..20).
    const one = await send(t, DEVICE_A, { events: [{ type: "device.queue_synced", detail: { synced: 3, failed: 0, size: 0 } }] });
    assert.equal(one.body.accepted, 1);
    assert.equal(countEvents(t, DEVICE_A) - before, 4);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("POST /api/devices/:id/events với type ngoài danh sách trắng trả 400 INVALID_EVENT_TYPE và KHÔNG ghi dòng nào", async () => {
  const t = await appWithDevice();
  try {
    const before = countEvents(t, DEVICE_A);
    /* Phần tử hỏng nằm ở GIỮA: nếu code ghi từng phần tử rồi mới validate thì phần tử đầu đã
     * lọt xuống DB và phép đếm dưới đây đỏ ngay. */
    const res = await send(t, DEVICE_A, {
      events: [
        { type: "device.camera_error", detail: { name: "NotReadableError" } },
        { type: "receipt.posted", detail: {} },
        { type: "device.battery_low", detail: { level: 0.05 } },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_EVENT_TYPE");
    assert.equal(res.body.error.details.type, "receipt.posted");
    assert.deepEqual(res.body.error.details.allowed, [...CLIENT_EVENT_TYPES]);
    assert.equal(countEvents(t, DEVICE_A), before, "một phần tử sai thì CẢ LÔ bị bỏ, không ghi phần tử nào");

    /* session.started là loại có thật trong EVENT_TYPES nhưng PDA KHÔNG được gửi: BE đã tự ghi
     * nó ở POST /api/sessions/start, để PDA gửi thêm sẽ thành hai dòng cho cùng một việc. */
    const forbidden = await send(t, DEVICE_A, { events: [{ type: "session.started", detail: {} }] });
    assert.equal(forbidden.status, 400);
    assert.equal(forbidden.body.error.code, "INVALID_EVENT_TYPE");
    assert.equal(countEvents(t, DEVICE_A), before);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("POST /api/devices/:id/events với mảng rỗng hoặc hơn 20 phần tử trả 400 INVALID_BODY", async () => {
  const t = await appWithDevice();
  try {
    const before = countEvents(t, DEVICE_A);
    const one = { type: "device.queue_synced", detail: { synced: 1, failed: 0, size: 0 } };

    const empty = await send(t, DEVICE_A, { events: [] });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, "INVALID_BODY");

    const tooMany = await send(t, DEVICE_A, { events: Array.from({ length: 21 }, () => one) });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, "INVALID_BODY");

    const notArray = await send(t, DEVICE_A, { events: { type: "device.queue_synced" } });
    assert.equal(notArray.status, 400);
    assert.equal(notArray.body.error.code, "INVALID_BODY");

    assert.equal(countEvents(t, DEVICE_A), before, "ba lô hỏng không được để lại dòng nào");

    // Biên TRÊN đúng 20 thì phải qua — nếu không, phép kiểm ">20" đang lệch một đơn vị.
    const exactly20 = await send(t, DEVICE_A, { events: Array.from({ length: 20 }, () => one) });
    assert.equal(exactly20.status, 202);
    assert.equal(exactly20.body.accepted, 20);
    assert.equal(countEvents(t, DEVICE_A) - before, 20);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("POST /api/devices/:id/events cho thiết bị chưa đăng ký trả 404 DEVICE_NOT_FOUND", async () => {
  const t = await appWithDevice();
  try {
    /* KHÔNG gửi x-device-id: mọi request mang header đó đều đi qua devices.touch() và tự đăng ký
     * thiết bị (Q3 của Phase 3) — route này cố ý KHÔNG nằm trong DEVICE_SELF_MANAGED. Định danh
     * lấy từ đường dẫn, nên đây đúng là trường hợp "thiết bị chưa từng đăng ký". */
    const res = await postJson(t.base, `/api/devices/${UNKNOWN_DEVICE}/events`, {
      events: [{ type: "device.battery_low", detail: { level: 0.2 } }],
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "DEVICE_NOT_FOUND");
    assert.equal(res.body.error.details.deviceId, UNKNOWN_DEVICE);
    assert.equal(countEvents(t, UNKNOWN_DEVICE), 0);

    // deviceId trong đường dẫn khác x-device-id → DEVICE_ID_MISMATCH của Phase 3, không phải 404.
    const mismatch = await postJson(
      t.base,
      `/api/devices/${DEVICE_B}/events`,
      { events: [{ type: "device.battery_low", detail: { level: 0.2 } }] },
      { "x-device-id": DEVICE_A },
    );
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, "DEVICE_ID_MISMATCH");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("POST /api/devices/:id/events bị chặn 503 BACKEND_READONLY khi backend.mode=readonly", async () => {
  const t = await appWithDevice();
  try {
    const before = countEvents(t, DEVICE_A);
    await putJson(t.base, "/api/admin/sim", { backend: { mode: "readonly" } });

    const res = await send(t, DEVICE_A, { events: [{ type: "device.camera_error", detail: { name: "AbortError" } }] });
    /* Nó là POST và KHÔNG nằm dưới /api/admin/ → chịu sim middleware như mọi endpoint ghi khác
     * (QUYẾT ĐỊNH A-10). Máy chủ đang chỉ đọc thì nó chỉ đọc. */
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "BACKEND_READONLY");
    assert.equal(countEvents(t, DEVICE_A), before);

    // Đối chứng: ĐỌC vẫn chạy trong chế độ readonly.
    assert.equal((await getJson(t.base, "/api/admin/events")).status, 200);

    // Tắt kịch bản thì ghi lại được ngay — chứng minh 503 ở trên là do readonly, không phải do lô hỏng.
    await delJson(t.base, "/api/admin/sim");
    const after = await send(t, DEVICE_A, { events: [{ type: "device.camera_error", detail: { name: "AbortError" } }] });
    assert.equal(after.status, 202);
    assert.equal(countEvents(t, DEVICE_A) - before, 1);
  } finally {
    await delJson(t.base, "/api/admin/sim");
    await t.stop();
    t.cleanup();
  }
});

test("at do client gửi vào cột client_at còn cột at luôn là giờ server", async () => {
  const t = await appWithDevice();
  try {
    const startedAt = Date.now();
    const CLIENT_AT = "2020-01-01T00:00:00.000Z"; // đồng hồ PDA lệch 6 năm
    const res = await send(t, DEVICE_A, {
      events: [
        { type: "device.battery_low", at: CLIENT_AT, detail: { level: 0.09 } },
        { type: "device.queue_enqueued", at: "hôm qua", detail: { reason: "OFFLINE", size: 1 } },
      ],
    });
    assert.equal(res.status, 202);

    const rows = t.app.db
      .prepare("SELECT type, at, client_at FROM system_events WHERE device_id = ? ORDER BY id ASC")
      .all(DEVICE_A);
    const battery = rows.find((r) => r.type === "device.battery_low");
    const queued = rows.find((r) => r.type === "device.queue_enqueued");

    assert.equal(battery.client_at, CLIENT_AT, "giờ client phải được giữ nguyên ở cột client_at");
    assert.ok(
      Date.parse(battery.at) >= startedAt,
      `cột at phải là giờ SERVER (>= ${new Date(startedAt).toISOString()}), nhận ${battery.at}`,
    );
    assert.notEqual(battery.at, CLIENT_AT, "không bao giờ lấy giờ PDA làm mốc sắp xếp");

    // `at` sai định dạng thì BỎ QUA, không báo lỗi và không làm hỏng cột at.
    assert.equal(queued.client_at, null);
    assert.ok(Date.parse(queued.at) >= startedAt);

    // Không gửi at thì client_at là NULL.
    await send(t, DEVICE_A, { events: [{ type: "device.sim_changed", detail: { network: "offline" } }] });
    const simRow = t.app.db
      .prepare("SELECT client_at FROM system_events WHERE device_id = ? AND type = 'device.sim_changed'")
      .get(DEVICE_A);
    assert.equal(simRow.client_at, null);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
