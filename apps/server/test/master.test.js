import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startTestApp, getJson, postJson, tempDataDir, recordingLogger, DEVICE_A } from "./helpers.js";

const isSorted = (codes) => codes.every((c, i) => i === 0 || codes[i - 1] < c);

test("GET /api/master/locations: ≥ 50 vị trí, có A-03-02, sắp xếp theo code tăng dần, mặc định chỉ active", async () => {
  const t = await startTestApp();
  try {
    const { status, body } = await getJson(t.base, "/api/master/locations?limit=200");
    assert.equal(status, 200);
    assert.ok(body.items.length >= 50, `chỉ có ${body.items.length} vị trí, cần ≥ 50`);
    assert.equal(body.total, body.items.length);
    assert.equal(body.truncated, false);
    assert.ok(typeof body.serverTime === "string" && body.serverTime.endsWith("Z"));

    const codes = body.items.map((i) => i.code);
    assert.ok(codes.includes("A-03-02"), "danh mục phải có A-03-02 (helpers.validData dùng mã này)");
    assert.ok(isSorted(codes), "code phải tăng dần");
    assert.equal(
      body.items.every((i) => i.active === true),
      true,
      "mặc định includeInactive=false nên mọi mục phải active",
    );
    assert.equal(codes.includes("B-01-07"), false, "B-01-07 là active=0, không được lọt vào mặc định");

    const one = body.items.find((i) => i.code === "A-03-02");
    assert.deepEqual(one, { code: "A-03-02", zone: "A", name: "Khu A · Kệ 03 · Tầng 02", active: true });

    /* Mặc định limit = 50 khi không truyền: items bị cắt còn 50 nhưng total vẫn là tổng thật. */
    const def = await getJson(t.base, "/api/master/locations");
    assert.equal(def.body.items.length, 50);
    assert.equal(def.body.total, body.total);
    assert.equal(def.body.truncated, true);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/master/locations?q=: lọc theo substring code và zone, không phân biệt hoa thường; total là số khớp TRƯỚC khi cắt limit", async () => {
  const t = await startTestApp();
  try {
    const lower = await getJson(t.base, "/api/master/locations?q=a-03");
    const upper = await getJson(t.base, "/api/master/locations?q=A-03");
    assert.deepEqual(
      lower.body.items.map((i) => i.code),
      upper.body.items.map((i) => i.code),
      "q không được phân biệt hoa thường",
    );
    assert.ok(lower.body.items.length > 0);
    assert.equal(
      lower.body.items.every((i) => i.code.includes("A-03")),
      true,
      "mọi mã trả về phải chứa chuỗi tìm kiếm",
    );

    /* q = "B" khớp theo zone: mọi vị trí khu B đều trả về, kể cả khi so trên cột zone. */
    const zone = await getJson(t.base, "/api/master/locations?q=b&limit=200");
    assert.ok(zone.body.items.length > 0);
    assert.equal(
      zone.body.items.every((i) => i.zone === "B"),
      true,
      "q=b phải trả đúng khu B",
    );

    /* total đếm TRƯỚC khi cắt: limit=2 nhưng total vẫn là tổng số khớp. */
    const cut = await getJson(t.base, "/api/master/locations?q=A&limit=2");
    const full = await getJson(t.base, "/api/master/locations?q=A&limit=200");
    assert.equal(cut.body.items.length, 2);
    assert.equal(cut.body.total, full.body.total);
    assert.ok(full.body.total > 2, "phải có hơn 2 vị trí khu A thì phép thử cắt mới có nghĩa");
    assert.equal(cut.body.truncated, true);
    assert.equal(full.body.truncated, false);

    /* limit ngoài 1..200 bị KẸP, không báo lỗi. */
    assert.equal((await getJson(t.base, "/api/master/locations?limit=0")).body.items.length, 1);
    assert.equal((await getJson(t.base, "/api/master/locations?limit=9999")).status, 200);
    assert.ok((await getJson(t.base, "/api/master/locations?limit=9999")).body.items.length <= 200);

    const none = await getJson(t.base, "/api/master/locations?q=ZZZZ");
    assert.deepEqual(none.body.items, []);
    assert.equal(none.body.total, 0);
    assert.equal(none.body.truncated, false);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/master/locations?includeInactive=true → có B-01-07 (active=false); q dài > 40 ký tự → 400 INVALID_QUERY", async () => {
  const t = await startTestApp();
  try {
    const on = await getJson(t.base, "/api/master/locations?includeInactive=true&limit=200");
    const b0107 = on.body.items.find((i) => i.code === "B-01-07");
    assert.ok(b0107, "includeInactive=true phải trả cả vị trí ngừng dùng");
    assert.equal(b0107.active, false);

    const off = await getJson(t.base, "/api/master/locations?includeInactive=false&limit=200");
    assert.equal(
      off.body.items.some((i) => i.code === "B-01-07"),
      false,
    );
    /* Chỉ đúng chuỗi "true" mới bật; "1"/"yes" là false. */
    const one = await getJson(t.base, "/api/master/locations?includeInactive=1&limit=200");
    assert.equal(one.body.total, off.body.total);
    assert.ok(on.body.total > off.body.total, "phải có ít nhất một vị trí active=0 để phép thử có nghĩa");

    const long = await getJson(t.base, `/api/master/locations?q=${"A".repeat(41)}`);
    assert.equal(long.status, 400);
    assert.equal(long.body.error.code, "INVALID_QUERY");
    assert.equal(long.body.error.message, "Tham số truy vấn không hợp lệ");
    assert.equal(long.body.error.details.field, "q");

    /* Đúng 40 ký tự vẫn hợp lệ — ranh giới nằm ở > 40. */
    const edge = await getJson(t.base, `/api/master/locations?q=${"A".repeat(40)}`);
    assert.equal(edge.status, 200);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("GET /api/master/warehouses và /api/master/shifts: shape đúng hợp đồng; shift code đúng sang/chieu/dem và POST /api/sessions/start nhận được cả 3", async () => {
  const t = await startTestApp();
  try {
    const wh = await getJson(t.base, "/api/master/warehouses");
    assert.equal(wh.status, 200);
    assert.ok(wh.body.items.length >= 2);
    assert.ok(typeof wh.body.serverTime === "string" && wh.body.serverTime.endsWith("Z"));
    for (const w of wh.body.items) {
      assert.deepEqual(Object.keys(w).sort(), ["active", "code", "name"]);
      assert.equal(typeof w.code, "string");
      assert.equal(typeof w.name, "string");
      assert.equal(typeof w.active, "boolean");
    }
    assert.ok(
      wh.body.items.some((w) => w.name === "Kho Long Biên"),
      "FE gửi name chứ không gửi code (Q26) nên name phải là chuỗi dùng được cho sessions.warehouse",
    );

    const sh = await getJson(t.base, "/api/master/shifts");
    assert.equal(sh.status, 200);
    assert.ok(typeof sh.body.serverTime === "string" && sh.body.serverTime.endsWith("Z"));
    assert.deepEqual(
      sh.body.items.map((s) => s.code),
      ["sang", "chieu", "dem"],
    );
    for (const s of sh.body.items) {
      assert.deepEqual(Object.keys(s).sort(), ["code", "endsAt", "name", "startsAt"]);
      assert.match(s.startsAt, /^\d{2}:\d{2}$/);
      assert.match(s.endsAt, /^\d{2}:\d{2}$/);
    }

    /* Danh mục ca phải khớp SHIFTS trong sessions.js: sai một chữ là POST /api/sessions/start
     * trả 400 INVALID_BODY và cả ca làm việc không mở được. */
    const warehouseName = wh.body.items[0].name;
    for (const s of sh.body.items) {
      const started = await postJson(
        t.base,
        "/api/sessions/start",
        { operator: "Kiểm thử", warehouse: warehouseName, shift: s.code },
        { "x-device-id": DEVICE_A },
      );
      assert.equal(started.status, 201, `ca "${s.code}" phải mở được phiên`);
      assert.equal(started.body.session.shift, s.code);
      assert.equal(started.body.session.warehouse, warehouseName);
    }
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("MASTER_DIR trỏ tới thư mục không tồn tại → 3 endpoint trả items rỗng, server VẪN khởi động, hasLocation fail-open trả true", async () => {
  const logger = recordingLogger();
  const dataDir = tempDataDir();
  const missing = path.join(dataDir, "khong-co-thu-muc-nay");
  const t = await startTestApp({ masterDir: missing, rules: { duplicate: false, location: true } }, { dataDir, logger });
  try {
    for (const p of ["/api/master/locations", "/api/master/warehouses", "/api/master/shifts"]) {
      const res = await getJson(t.base, p);
      assert.equal(res.status, 200, `${p} phải vẫn trả 200`);
      assert.deepEqual(res.body.items, [], `${p} phải trả items rỗng`);
    }
    assert.equal((await getJson(t.base, "/api/master/locations")).body.total, 0);

    assert.equal(t.app.master.loaded, false);
    assert.equal(t.app.master.hasLocation("A-03-02"), true, "fail-open: không có danh mục thì không chặn ai");
    assert.equal(t.app.master.hasLocation("KHONG-CO-THAT"), true);
    assert.deepEqual(t.app.master.suggestLocations("A-99-99", 3), []);

    /* Có ghi cảnh báo cho từng file thiếu — im lặng nuốt lỗi là cách chắc chắn nhất để không ai
     * biết danh mục đã biến mất. */
    const warns = logger.find("master.load_failed");
    assert.equal(warns.length, 3, `phải cảnh báo cho cả 3 file, nhận ${warns.length}`);
    assert.equal(
      warns.every((w) => w.level === "warn" && typeof w.error === "string" && w.file.startsWith(missing)),
      true,
    );

    /* Server vẫn phục vụ bình thường: /api/health còn sống. */
    assert.equal((await getJson(t.base, "/api/health")).status, 200);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
