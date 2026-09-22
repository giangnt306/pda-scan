/* KHÔNG LOẠI SỰ KIỆN NÀO ĐƯỢC PHÉP CHẾT.
 *
 * `EVENT_TYPES` là bảng đăng ký 31 loại của `02-contracts-api.md` §4.3. Một loại được khai ở đó,
 * có nhãn tiếng Việt ở monitor, nhưng KHÔNG nơi nào phát ra thì cả chuỗi đó là code chết — và
 * không một test nào phát hiện được, vì mọi test đều kiểm "ghi rồi đọc lại" với dữ liệu do
 * chính nó bơm vào.
 *
 * Mỗi loại chỉ có đúng hai đường ra đời:
 *   1. do CHÍNH BE phát — tên xuất hiện trong `apps/server/src/**`;
 *   2. do THIẾT BỊ gửi lên qua `POST /api/devices/:id/events` — tên nằm trong
 *      `CLIENT_EVENT_TYPES` và đường đi đó phải thật sự thông (test thứ hai kiểm bằng HTTP).
 * Loại nào không thuộc đường nào là loại chết.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES, CLIENT_EVENT_TYPES } from "../src/events.js";
import { startTestApp, postJson, getJson, DEVICE_A } from "./helpers.js";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const REGISTRY_FILE = path.join(SRC_DIR, "events.js");

function jsFilesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFilesUnder(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}

/* Mã nguồn của BE, BỎ chính bảng đăng ký (nơi nào cũng có đủ 31 tên nên nó làm phép kiểm vô
 * nghĩa) và BỎ các dòng chú thích: một cái tên chỉ được nhắc trong comment thì không phải là
 * nơi phát. Lọc thô theo dòng — đủ cho mục đích ở đây, và test thứ ba chứng minh bộ dò này
 * không phải lúc nào cũng trả true. */
const serverCode = jsFilesUnder(SRC_DIR)
  .filter((f) => f !== REGISTRY_FILE)
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n")
  .split("\n")
  .filter((line) => {
    const s = line.trim();
    return !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
  })
  .join("\n");

const emittedByServer = (type) => serverCode.includes(`"${type}"`);

test("mỗi loại trong EVENT_TYPES đều có nơi phát: hoặc apps/server/src phát, hoặc thiết bị gửi lên", () => {
  const fromDevice = new Set(CLIENT_EVENT_TYPES);
  const orphan = Object.keys(EVENT_TYPES).filter((type) => !fromDevice.has(type) && !emittedByServer(type));
  assert.deepEqual(orphan, [], `loại sự kiện được khai nhưng không nơi nào phát: ${orphan.join(", ")}`);
  assert.equal(Object.keys(EVENT_TYPES).length, 31, "02-contracts-api.md §4.3: 16 loại cố định + 15 loại receipt.*");
});

test("bộ dò «nơi phát» không phải lúc nào cũng trả true: tên bịa không có nơi phát, tên thật thì có", () => {
  assert.equal(emittedByServer("recognition.started"), true, "recognition.started được phát trong recognition/service.js");
  assert.equal(emittedByServer("receipt.posted"), true, "receipt.posted được phát trong outboxWorker.js");
  assert.equal(emittedByServer("khong.co.loai.nay"), false, "bộ dò trả true cho mọi chuỗi thì phép kiểm trên là vô nghĩa");
  for (const type of CLIENT_EVENT_TYPES) {
    assert.equal(emittedByServer(type), false, `${type} là sự kiện của THIẾT BỊ; BE tự phát nó sẽ thành hai dòng cho một việc`);
  }
});

test("mọi loại trong CLIENT_EVENT_TYPES đều nằm trong EVENT_TYPES", () => {
  const missing = CLIENT_EVENT_TYPES.filter((type) => !Object.hasOwn(EVENT_TYPES, type));
  assert.deepEqual(missing, [], "loại thiết bị được phép gửi nhưng events.write() sẽ ném vì không có trong bảng đăng ký");
});

test("đường đi của từng loại CLIENT_EVENT_TYPES thông thật: POST /api/devices/:id/events nhận và GET /api/admin/events đọc lại được", async () => {
  const t = await startTestApp();
  try {
    await postJson(t.base, "/api/devices/register", { name: "PDA-A" }, { "x-device-id": DEVICE_A });

    /* `detail` đúng hình dạng mà §4.3 khai cho từng loại: gửi detail rỗng sẽ không chứng minh
     * được dữ liệu về nguyên vẹn. */
    const DETAIL = {
      "device.camera_error": { name: "NotAllowedError" },
      "device.battery_low": { level: 0.12 },
      "device.queue_enqueued": { reason: "OFFLINE", size: 3 },
      "device.queue_synced": { synced: 3, failed: 0, size: 0 },
      "device.sim_changed": { scope: "device", section: "backend" },
    };
    const missingFixture = CLIENT_EVENT_TYPES.filter((type) => !Object.hasOwn(DETAIL, type));
    assert.deepEqual(missingFixture, [], "thêm loại mới vào CLIENT_EVENT_TYPES thì phải thêm cả detail mẫu ở đây");

    const posted = await postJson(
      t.base,
      `/api/devices/${DEVICE_A}/events`,
      { events: CLIENT_EVENT_TYPES.map((type) => ({ type, detail: DETAIL[type] })) },
      { "x-device-id": DEVICE_A },
    );
    assert.equal(posted.status, 202);
    assert.equal(posted.body.accepted, CLIENT_EVENT_TYPES.length, "một loại bị từ chối là một loại chết ở phía BE");
    assert.equal(posted.body.rejected, 0);

    const list = await getJson(t.base, "/api/admin/events?since=0&limit=200", { "x-device-id": DEVICE_A });
    assert.equal(list.status, 200);
    const byType = new Map(list.body.items.map((e) => [e.type, e]));
    for (const type of CLIENT_EVENT_TYPES) {
      const row = byType.get(type);
      assert.ok(row, `${type} không đọc lại được ở GET /api/admin/events`);
      assert.deepEqual(row.detail, DETAIL[type], `detail của ${type} phải về nguyên vẹn`);
      assert.equal(row.deviceId, DEVICE_A);
      assert.equal(row.severity, EVENT_TYPES[type], "severity mặc định phải lấy từ bảng đăng ký");
    }
  } finally {
    await t.stop();
    t.cleanup();
  }
});
