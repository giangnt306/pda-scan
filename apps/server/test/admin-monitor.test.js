import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, getJson, postJson, putJson, delJson, upload, waitFor, JPEG, DEVICE_A, DEVICE_B } from "./helpers.js";

/* Hai endpoint đọc của màn hình giám sát S9:
 *   GET /api/admin/events        — dòng sự kiện theo con trỏ `since` tăng dần (§4.6)
 *   GET /api/admin/recognitions  — hàng đợi nhận dạng, mới-nhất-trước (§4.7)
 * Cả hai nằm dưới /api/admin/ nên KHÔNG bị sim middleware chặn — monitor phải sống khi hệ
 * thống "chết", đó là lúc người ta cần nó nhất. */

const typesOf = (body) => body.items.map((e) => e.type);

test("GET /api/admin/events?since=abc trả 400 INVALID_SINCE kèm details.since là giá trị thô", async () => {
  const t = await startTestApp();
  try {
    const bad = await getJson(t.base, "/api/admin/events?since=abc");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_SINCE");
    assert.equal(bad.body.error.details.since, "abc", "phải trả lại đúng giá trị thô để còn gỡ lỗi được");

    // Số âm và số thực cũng không phải "số nguyên không âm".
    assert.equal((await getJson(t.base, "/api/admin/events?since=-3")).body.error.code, "INVALID_SINCE");
    assert.equal((await getJson(t.base, "/api/admin/events?since=1.5")).body.error.code, "INVALID_SINCE");

    // Đối chứng: vắng mặt và số nguyên hợp lệ đều 200 — chứng minh không phải lúc nào cũng 400.
    assert.equal((await getJson(t.base, "/api/admin/events")).status, 200);
    assert.equal((await getJson(t.base, "/api/admin/events?since=0")).status, 200);
    assert.equal((await getJson(t.base, "/api/admin/events?since=12")).status, 200);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/admin/events lọc theo type và trả đúng những dòng có type đó", async () => {
  const t = await startTestApp();
  try {
    // Ba loại sự kiện KHÁC NHAU do ba hành động thật sinh ra.
    await postJson(t.base, "/api/devices/register", { name: "PDA-A" }, { "x-device-id": DEVICE_A });
    await postJson(t.base, "/api/sessions/start", { operator: "Nam", warehouse: "WH01" }, { "x-device-id": DEVICE_A });
    await putJson(t.base, "/api/admin/sim", { ocr: { mode: "partial" } });

    const only = await getJson(t.base, "/api/admin/events?type=session.started");
    assert.equal(only.status, 200);
    assert.equal(only.body.items.length, 1);
    assert.deepEqual(typesOf(only.body), ["session.started"]);
    assert.equal(only.body.items[0].deviceId, DEVICE_A);
    assert.equal(only.body.items[0].detail.operator, "Nam");

    // Nhiều loại ngăn bằng dấu phẩy: đúng 2 dòng, KHÔNG kéo theo sim.updated.
    const two = await getJson(t.base, "/api/admin/events?type=session.started,device.registered");
    assert.deepEqual(typesOf(two.body).sort(), ["device.registered", "session.started"]);

    // Lặp &type= cũng phải gom lại như nhau.
    const repeated = await getJson(t.base, "/api/admin/events?type=session.started&type=device.registered");
    assert.deepEqual(typesOf(repeated.body).sort(), ["device.registered", "session.started"]);

    // Không lọc thì phải thấy nhiều hơn — chứng minh bộ lọc trên thật sự có tác dụng.
    const all = await getJson(t.base, "/api/admin/events");
    assert.ok(all.body.items.length > two.body.items.length);
    assert.ok(typesOf(all.body).includes("sim.updated"));
  } finally {
    await delJson(t.base, "/api/admin/sim");
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/admin/events với severity không hợp lệ BỎ bộ lọc và vẫn trả 200", async () => {
  const t = await startTestApp();
  try {
    await postJson(t.base, "/api/devices/register", { name: "PDA-A" }, { "x-device-id": DEVICE_A }); // info
    await putJson(t.base, "/api/admin/sim", { backend: { mode: "degraded", latencyMs: 50 } }); // warn

    const bogus = await getJson(t.base, "/api/admin/events?severity=catastrophic");
    assert.equal(bogus.status, 200, "giá trị lạ là BỎ LỌC, không phải lỗi");
    const severities = new Set(bogus.body.items.map((e) => e.severity));
    assert.ok(severities.has("info") && severities.has("warn"), "bỏ lọc thì phải thấy CẢ hai mức");

    // Đối chứng: severity hợp lệ thì lọc thật.
    const warnOnly = await getJson(t.base, "/api/admin/events?severity=warn");
    assert.equal(warnOnly.status, 200);
    assert.ok(warnOnly.body.items.length >= 1);
    assert.deepEqual([...new Set(warnOnly.body.items.map((e) => e.severity))], ["warn"]);
    assert.ok(warnOnly.body.items.length < bogus.body.items.length);

    // deviceId sai định dạng cũng bỏ lọc chứ không lỗi (cùng nết khoan dung).
    const badDevice = await getJson(t.base, "/api/admin/events?deviceId=khong-phai-uuid");
    assert.equal(badDevice.status, 200);
    assert.equal(badDevice.body.items.length, bogus.body.items.length);
  } finally {
    await delJson(t.base, "/api/admin/sim");
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/admin/events KHÔNG bị chặn khi backend.mode=down", async () => {
  const t = await startTestApp();
  try {
    await postJson(t.base, "/api/devices/register", { name: "PDA-A" }, { "x-device-id": DEVICE_A });
    await putJson(t.base, "/api/admin/sim", { backend: { mode: "down" } });

    // Đối chứng: kịch bản ĐANG bật thật — endpoint nghiệp vụ bị chặn.
    const blocked = await getJson(t.base, "/api/receipts");
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error.code, "BACKEND_DOWN_SIMULATED");

    const events = await getJson(t.base, "/api/admin/events");
    assert.equal(events.status, 200, "monitor phải sống đúng lúc hệ thống chết");
    assert.ok(events.body.items.length >= 1, "vẫn đọc được dữ liệu, không phải 200 rỗng vì bị chặn");
    assert.ok(typesOf(events.body).includes("device.registered"));

    const recognitions = await getJson(t.base, "/api/admin/recognitions");
    assert.equal(recognitions.status, 200);
  } finally {
    await delJson(t.base, "/api/admin/sim");
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/admin/recognitions?status=pending chỉ trả dòng pending và counts đếm toàn bảng", async () => {
  /* maxConcurrent = 4 để 4 lần nhận dạng cùng chạy, không ai phải xếp hàng;
   * timeoutMs = 3000 cho cửa sổ quan sát "pending" rộng rãi mà test vẫn nhanh. */
  const t = await startTestApp({ recognitionMode: "async", recognitionTimeoutMs: 3000, recognitionMaxConcurrent: 4 });
  try {
    const hang1 = (await upload(t.base, JPEG, { query: "?sim=timeout" })).body.recognitionId;
    const hang2 = (await upload(t.base, JPEG, { query: "?sim=timeout" })).body.recognitionId;
    const good = (await upload(t.base, JPEG)).body.recognitionId;
    const bad = (await upload(t.base, JPEG, { query: "?sim=error" })).body.recognitionId;

    const counts = await waitFor(
      async () => {
        const r = await getJson(t.base, "/api/admin/recognitions?limit=10");
        return r.body.counts.completed === 1 && r.body.counts.failed === 1 ? r.body.counts : null;
      },
      { label: "hai job nhanh kết thúc" },
    );
    // 2 / 1 / 1 là ba con số KHÁC NHAU: lẫn cột nào với cột nào cũng lộ ra.
    assert.deepEqual({ ...counts }, { pending: 2, completed: 1, failed: 1 });

    const onlyPending = await getJson(t.base, "/api/admin/recognitions?status=pending");
    assert.equal(onlyPending.status, 200);
    assert.equal(onlyPending.body.items.length, 2);
    assert.deepEqual([...new Set(onlyPending.body.items.map((i) => i.status))], ["pending"]);
    assert.deepEqual(onlyPending.body.items.map((i) => i.recognitionId).sort(), [hang1, hang2].sort());
    // counts đếm TOÀN BẢNG, không chỉ trang vừa lọc.
    assert.deepEqual({ ...onlyPending.body.counts }, { pending: 2, completed: 1, failed: 1 });

    // status lạ → bỏ lọc, trả đủ 4 dòng chứ không lỗi.
    const bogus = await getJson(t.base, "/api/admin/recognitions?status=khong-ton-tai&limit=10");
    assert.equal(bogus.status, 200);
    assert.equal(bogus.body.items.length, 4);
    assert.ok(bogus.body.items.map((i) => i.recognitionId).includes(good));
    assert.ok(bogus.body.items.map((i) => i.recognitionId).includes(bad));

    // Dọn: chờ hai job treo hết ngân sách để app.close() không phải drain lâu.
    await waitFor(
      async () => (await getJson(t.base, "/api/admin/recognitions?limit=10")).body.counts.pending === 0,
      { timeoutMs: 8000, label: "hai job timeout kết thúc" },
    );
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/admin/recognitions trả ageMs tính từ serverTime và KHÔNG trả trường fields", async () => {
  const t = await startTestApp();
  try {
    const created = (await upload(t.base, JPEG, { headers: { "x-device-id": DEVICE_B } })).body;
    assert.equal(created.fieldsFound > 0, true, "phải có nhãn đọc được thì phép kiểm 'không lộ fields' mới có nghĩa");

    const res = await getJson(t.base, "/api/admin/recognitions?limit=5");
    assert.equal(res.status, 200);
    const item = res.body.items.find((i) => i.recognitionId === created.recognitionId);
    assert.ok(item, "dòng vừa tạo phải có trong danh sách");

    /* ageMs do SERVER tính từ cùng một mốc với serverTime — bằng ĐÚNG hiệu số, không xấp xỉ.
     * Lấy Date.now() hai lần ở hai chỗ sẽ làm đẳng thức này sai. */
    assert.equal(item.ageMs, Date.parse(res.body.serverTime) - Date.parse(item.createdAt));
    assert.ok(item.ageMs >= 0);

    // Không có dữ liệu nhãn ở đây: monitor không cần nó, và đó là dữ liệu nghiệp vụ.
    assert.equal(Object.hasOwn(item, "fields"), false);
    assert.equal(Object.hasOwn(item, "normalized"), false);
    assert.equal(JSON.stringify(res.body).includes("BEX32181030AB"), false, "giá trị nhãn không được lọt ra endpoint này");
    assert.deepEqual(Object.keys(item).sort(), [
      "ageMs",
      "createdAt",
      "deviceId",
      "durationMs",
      "errorCode",
      "fieldsFound",
      "finishedAt",
      "imageId",
      "provider",
      "recognitionId",
      "sessionId",
      "status",
    ]);
    assert.equal(item.deviceId, DEVICE_B);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/admin/events trả oldestId trên MỌI response, kể cả trang rỗng và trang đã lọc (F-11)", async () => {
  const t = await startTestApp({ events: { enabled: true, maxRows: 20, trimEvery: 1, mirrorReceipts: true } });
  try {
    await postJson(t.base, "/api/devices/register", { name: "PDA-A" }, { "x-device-id": DEVICE_A });
    for (let i = 0; i < 3; i += 1) {
      const res = await postJson(
        t.base,
        `/api/devices/${DEVICE_A}/events`,
        { events: Array.from({ length: 20 }, (_, k) => ({ type: "device.battery_low", detail: { level: 0.1, i: i * 20 + k } })) },
        { "x-device-id": DEVICE_A },
      );
      assert.equal(res.status, 202);
    }
    const lo = t.app.db.prepare("SELECT MIN(id) AS lo FROM system_events").get().lo;
    assert.ok(lo > 1, "tiền đề: vòng xoay phải đã cắt mất dòng đầu tiên");

    const page = await getJson(t.base, `/api/admin/events?since=1&limit=200`);
    assert.equal(page.status, 200);
    assert.equal(page.body.oldestId, lo);

    /* Trang RỖNG vì bộ lọc không khớp dòng nào: vẫn phải mang oldestId, vì đây đúng là lúc
     * người đọc dễ kết luận nhầm "không có gì xảy ra". */
    const filtered = await getJson(t.base, "/api/admin/events?since=1&type=receipt.posted&limit=200");
    assert.equal(filtered.body.items.length, 0, "tiền đề: bộ lọc này phải ra trang rỗng");
    assert.equal(filtered.body.oldestId, lo, "bộ lọc không được làm oldestId biến mất hay đổi giá trị");

    // Con trỏ vượt quá dòng cuối: cũng rỗng, cũng phải mang đúng sàn của bảng.
    const ahead = await getJson(t.base, "/api/admin/events?since=99999&limit=200");
    assert.equal(ahead.body.items.length, 0);
    assert.equal(ahead.body.lastId, 99999);
    assert.equal(ahead.body.oldestId, lo);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("EVENTS_ENABLED=false: GET /api/admin/events trả oldestId=0 — không bịa ra một mốc cũ nhất", async () => {
  const t = await startTestApp({ events: { enabled: false, maxRows: 2000, trimEvery: 100, mirrorReceipts: true } });
  try {
    const res = await getJson(t.base, "/api/admin/events?since=77");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.lastId, 77);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.oldestId, 0, "sổ tắt thì client KHÔNG được kết luận mình đã mất dòng");
  } finally {
    await t.stop();
    t.cleanup();
  }
});
