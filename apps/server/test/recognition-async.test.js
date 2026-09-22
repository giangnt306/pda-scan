import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig, RECOGNITION_MODES } from "../src/config.js";
import { createSemaphore } from "../src/recognition/semaphore.js";
import { startTestApp, upload, getJson, waitFor, JPEG, DEVICE_A } from "./helpers.js";

/* Đặt biến môi trường rồi TRẢ LẠI nguyên trạng, kể cả khi assert ném giữa chừng. */
async function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* Provider có cổng chặn: test tự quyết định khi nào một lần nhận dạng kết thúc, nên trạng thái
 * "pending" quan sát được một cách tất định, không phụ thuộc đồng hồ. */
function gatedProvider() {
  let inflight = 0;
  let started = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  return {
    name: "mock",
    get inflight() {
      return inflight;
    },
    get started() {
      return started;
    },
    open: () => release(),
    async recognize({ signal }) {
      inflight += 1;
      started += 1;
      try {
        await Promise.race([
          gate,
          new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
        ]);
        return { raw: { model: "gated" }, fields: { partNumber: { value: "BEX32181030AB", confidence: 0.94 } } };
      } finally {
        inflight -= 1;
      }
    },
  };
}

/* Gửi một upload bằng http.request THÔ rồi GIẾT socket ngay sau khi nhận xong response.
 * Không dùng fetch: undici trả kết nối về pool nên không chứng minh được "client đã biến mất". */
async function uploadThenKillSocket(base, buffer, { headers = {} } = {}) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/jpeg" }), "label.jpg");
  const serialized = new Request("http://local/upload", { method: "POST", body: form });
  const payload = Buffer.from(await serialized.arrayBuffer());
  const url = new URL("/api/recognitions", base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": serialized.headers.get("content-type"),
          "content-length": payload.length,
          ...headers,
        },
      },
      (res) => {
        /* Giữ tham chiếu socket NGAY tại đây: tới lúc sự kiện "end" bắn thì res.socket đã bị
         * Node tháo ra và trả về null. */
        const socket = res.socket;
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          socket.destroy(); // PDA rút ứng dụng: socket đứt hẳn
          resolve({ status: res.statusCode, body, headers: res.headers, socketDestroyed: socket.destroyed });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const modeOf = (app, recognitionId) => app.db.prepare("SELECT mode FROM recognitions WHERE id = ?").get(recognitionId).mode;

test('RECOGNITION_MODE mặc định là "sync" khi không đặt biến môi trường', async () => {
  await withEnv({ RECOGNITION_MODE: undefined }, () => {
    const cfg = loadConfig({ dotenv: false });
    assert.equal(cfg.recognitionMode, "sync", "bật async mặc định sẽ phá mọi test cũ của POST /api/recognitions");
    assert.equal(cfg.recognitionPollHintMs, 1000);
  });
  // Đặt tường minh vẫn phải đọc đúng — chứng minh giá trị trên là MẶC ĐỊNH, không phải hằng cứng.
  await withEnv({ RECOGNITION_MODE: "async" }, () => {
    assert.equal(loadConfig({ dotenv: false }).recognitionMode, "async");
  });
});

test('RECOGNITION_MODE="xyz" làm loadConfig ném lỗi nêu đúng hai giá trị hợp lệ', async () => {
  await withEnv({ RECOGNITION_MODE: "xyz" }, () => {
    assert.throws(
      () => loadConfig({ dotenv: false }),
      (err) => {
        assert.match(err.message, /RECOGNITION_MODE/);
        assert.match(err.message, /sync, async/);
        return true;
      },
    );
  });
  assert.deepEqual([...RECOGNITION_MODES], ["sync", "async"], "đúng hai chế độ, không hơn");
});

test("chế độ sync: POST /api/recognitions vẫn trả 201 kèm fields — hành vi Phase 1-4 không đổi", async () => {
  const t = await startTestApp(); // không truyền recognitionMode → mặc định
  try {
    assert.equal(t.config.recognitionMode, "sync");
    const res = await upload(t.base, JPEG);
    assert.equal(res.status, 201, "chế độ sync phải giữ nguyên 201, không phải 202");
    assert.equal(res.body.status, "completed");
    assert.ok(res.body.fields, "sync trả fields ngay trong response");
    assert.equal(res.body.fields.partNumber.value, "BEX32181030AB");
    assert.ok(res.body.fieldsFound > 0);
    assert.equal(res.headers.get("location"), null, "201 của chế độ sync KHÔNG có header location");
    assert.equal(res.body.pollUrl, undefined, "201 của chế độ sync KHÔNG có pollUrl");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test('chế độ async: POST /api/recognitions trả 202 với status "pending", fields null, fieldsFound 0', async () => {
  const provider = gatedProvider();
  const t = await startTestApp({ recognitionMode: "async" }, { provider });
  try {
    const res = await upload(t.base, JPEG);
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "pending");
    assert.equal(res.body.fields, null);
    assert.equal(res.body.fieldsFound, 0);
    assert.equal(res.body.error, null);
    assert.equal(res.body.durationMs, null);
    assert.equal(res.body.finishedAt, null);
    assert.ok(res.body.image.id, "ảnh đã được lưu trước khi trả 202");
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});

test("202 có header location và retry-after, body có pollUrl và pollAfterMs đúng RECOGNITION_POLL_HINT_MS", async () => {
  const provider = gatedProvider();
  /* 1500 ms cố ý KHÔNG phải bội số tròn của 1000: retry-after = ceil(1500/1000) = 2, nên một
   * phép làm tròn xuống (floor → 1) sẽ lộ ra ngay. */
  const t = await startTestApp({ recognitionMode: "async", recognitionPollHintMs: 1500 }, { provider });
  try {
    const res = await upload(t.base, JPEG);
    assert.equal(res.status, 202);
    const id = res.body.recognitionId;
    assert.equal(res.headers.get("location"), `/api/recognitions/${id}`);
    assert.equal(res.headers.get("retry-after"), "2");
    assert.equal(res.body.pollUrl, `/api/recognitions/${id}`);
    assert.equal(res.body.pollAfterMs, 1500);

    /* pollUrl/pollAfterMs CHỈ có ở 202; GET /api/recognitions/:id không có chúng, nếu không FE
     * sẽ không biết lần poll thứ mấy là lần cuối (QUYẾT ĐỊNH A-2). */
    const polled = await getJson(t.base, `/api/recognitions/${id}`);
    assert.equal(polled.body.pollUrl, undefined);
    assert.equal(polled.body.pollAfterMs, undefined);
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});

test("chế độ async: GET /api/recognitions/:id chuyển pending → completed và trả fields đã chuẩn hoá", async () => {
  const provider = gatedProvider();
  const t = await startTestApp({ recognitionMode: "async" }, { provider });
  try {
    const id = (await upload(t.base, JPEG)).body.recognitionId;

    const whilePending = await getJson(t.base, `/api/recognitions/${id}`);
    assert.equal(whilePending.status, 200);
    assert.equal(whilePending.body.status, "pending");
    assert.equal(whilePending.body.fields, null);

    provider.open();
    const done = await waitFor(
      async () => {
        const r = await getJson(t.base, `/api/recognitions/${id}`);
        return r.body.status === "completed" ? r.body : null;
      },
      { label: 'poll chuyển sang "completed"' },
    );
    // fields đã qua normalizeRecognitionFields: có status/raw chứ không phải giá trị thô của provider.
    assert.equal(done.fields.partNumber.value, "BEX32181030AB");
    assert.equal(done.fields.partNumber.status, "ok");
    assert.equal(done.fieldsFound, 1);
    assert.ok(done.durationMs !== null && done.durationMs >= 0);
    assert.ok(done.finishedAt, "job xong phải có finishedAt");
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});

test('chế độ async: GET /api/recognitions/:id của job lỗi trả HTTP 200 với status "failed" và error.code', async () => {
  const t = await startTestApp({ recognitionMode: "async" });
  try {
    // ?sim=error → wrapper ném PROVIDER_ERROR trong job nền.
    const id = (await upload(t.base, JPEG, { query: "?sim=error" })).body.recognitionId;
    const failed = await waitFor(
      async () => {
        const r = await getJson(t.base, `/api/recognitions/${id}`);
        return r.body.status === "failed" ? r : null;
      },
      { label: 'poll chuyển sang "failed"' },
    );
    /* 200, KHÔNG phải 5xx (QUYẾT ĐỊNH A-3): 5xx sẽ khiến transport.js của PDA xếp vào
     * SERVER_DOWN/TIMEOUT rồi tự retry một kết quả đã kết thúc. */
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.error.code, "RECOGNITION_FAILED");
    assert.ok(failed.body.error.message);
    assert.equal(failed.body.fields, null);
    assert.equal(failed.body.fieldsFound, 0);

    // id không tồn tại vẫn là 404 như Phase 1 — "truy vấn hỏng" khác "công việc hỏng".
    const missing = await getJson(t.base, "/api/recognitions/00000000-0000-4000-8000-000000000000");
    assert.equal(missing.status, 404);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("chế độ async: client ngắt kết nối sau khi nhận 202 KHÔNG huỷ job — kết quả vẫn ghi vào DB", async () => {
  const provider = gatedProvider();
  const t = await startTestApp({ recognitionMode: "async" }, { provider });
  try {
    const res = await uploadThenKillSocket(t.base, JPEG, { "x-device-id": DEVICE_A });
    assert.equal(res.status, 202);
    assert.equal(res.socketDestroyed, true, "test này vô nghĩa nếu kết nối chưa thật sự đứt");
    const id = res.body.recognitionId;

    // Job vẫn đang chạy sau khi client biến mất.
    assert.ok(await waitFor(() => provider.inflight === 1, { label: "job nền vẫn đang chạy" }));
    provider.open();

    const row = await waitFor(
      () => {
        const r = t.app.db.prepare("SELECT status, error_code FROM recognitions WHERE id = ?").get(id);
        return r.status !== "pending" ? r : null;
      },
      { label: "job nền ghi xong kết quả" },
    );
    assert.equal(row.status, "completed", "client bỏ đi KHÔNG được biến job thành CLIENT_ABORTED");
    assert.equal(row.error_code, null);
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});

test('chế độ async: dòng recognitions có mode="async"; chế độ sync có mode="sync"', async () => {
  const asyncApp = await startTestApp({ recognitionMode: "async" });
  let syncApp;
  try {
    const asyncId = (await upload(asyncApp.base, JPEG)).body.recognitionId;
    assert.equal(modeOf(asyncApp.app, asyncId), "async");

    syncApp = await startTestApp();
    const syncId = (await upload(syncApp.base, JPEG)).body.recognitionId;
    assert.equal(modeOf(syncApp.app, syncId), "sync");
  } finally {
    await asyncApp.stop();
    asyncApp.cleanup();
    if (syncApp) {
      await syncApp.stop();
      syncApp.cleanup();
    }
  }
});

test("chế độ async: header x-capture-ref được lưu vào cột capture_ref và cắt còn 64 ký tự", async () => {
  const t = await startTestApp({ recognitionMode: "async" });
  try {
    /* Chuỗi 80 ký tự KHÔNG lặp lại: cắt nhầm đầu/đuôi hay nhầm độ dài đều lộ ra. */
    const long = "capture-".concat(Array.from({ length: 72 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(""));
    assert.equal(long.length, 80);
    const longId = (await upload(t.base, JPEG, { headers: { "x-capture-ref": long } })).body.recognitionId;

    const short = "cap-2026-09-22-0007";
    const shortId = (await upload(t.base, JPEG, { headers: { "x-capture-ref": short } })).body.recognitionId;
    const plainId = (await upload(t.base, JPEG)).body.recognitionId;

    const refOf = (id) => t.app.db.prepare("SELECT capture_ref FROM recognitions WHERE id = ?").get(id).capture_ref;
    assert.equal(refOf(longId).length, 64);
    assert.equal(refOf(longId), long.slice(0, 64));
    assert.equal(refOf(shortId), short, "chuỗi ngắn phải giữ NGUYÊN, không bị đệm hay cắt");
    assert.equal(refOf(plainId), null, "không gửi header thì cột là NULL");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("canAdmit() trả false khi inflight đạt maxConcurrent VÀ waiting đạt maxWaiting", async () => {
  /* 2 và 3 khác nhau có chủ đích: lẫn hai ngưỡng cho nhau là lộ ngay. */
  const s = createSemaphore({ maxConcurrent: 2, maxWaiting: 3, maxWaitMs: 60000 });
  const pending = [];
  try {
    assert.equal(s.canAdmit(), true, "hàng rỗng thì phải nhận");

    pending.push(s.acquire(null), s.acquire(null)); // inflight = 2 = maxConcurrent
    assert.deepEqual(s.stats(), { inflight: 2, waiting: 0 });
    assert.equal(s.canAdmit(), true, "đầy chỗ chạy nhưng còn chỗ CHỜ thì vẫn nhận");

    pending.push(s.acquire(null), s.acquire(null)); // waiting = 2 < 3
    assert.deepEqual(s.stats(), { inflight: 2, waiting: 2 });
    assert.equal(s.canAdmit(), true);

    pending.push(s.acquire(null)); // waiting = 3 = maxWaiting
    assert.deepEqual(s.stats(), { inflight: 2, waiting: 3 });
    assert.equal(s.canAdmit(), false, "đầy CẢ chỗ chạy lẫn chỗ chờ thì mới từ chối");

    // Nhả một slot → chỗ chờ tụt xuống 2 → nhận lại được.
    s.release();
    assert.equal(s.stats().waiting, 2);
    assert.equal(s.canAdmit(), true);
  } finally {
    for (const p of pending) p.catch(() => {});
    for (let i = 0; i < 6; i += 1) s.release();
  }
});

test("chế độ async: upload vượt maxConcurrent+maxWaiting nhận 429 RECOGNITION_BUSY kèm retry-after", async () => {
  const provider = gatedProvider();
  const t = await startTestApp(
    {
      recognitionMode: "async",
      recognitionMaxConcurrent: 2,
      recognitionMaxWaiting: 3,
      recognitionMaxWaitMs: 60000,
      recognitionBusyRetryAfterMs: 4000,
    },
    { provider },
  );
  try {
    // Sức chứa = 2 + 3 = 5; bắn 8 để chắc chắn có request bị từ chối.
    const results = await Promise.all(Array.from({ length: 8 }, () => upload(t.base, JPEG)));
    const accepted = results.filter((r) => r.status === 202);
    const busy = results.filter((r) => r.status === 429);

    assert.equal(accepted.length + busy.length, 8, `không request nào được phép trả mã khác: ${results.map((r) => r.status)}`);
    assert.equal(accepted.length, 5, "đúng maxConcurrent + maxWaiting request được nhận");
    assert.equal(busy.length, 3);
    for (const r of busy) {
      assert.equal(r.body.error.code, "RECOGNITION_BUSY");
      assert.equal(r.headers.get("retry-after"), "4", "ceil(4000/1000) = 4");
      assert.equal(r.body.error.details.retryAfterMs, 4000);
      assert.equal(typeof r.body.error.details.inflight, "number");
      assert.equal(typeof r.body.error.details.waiting, "number");
    }
    // 429 KHÔNG để lại dòng recognitions nào: đúng 5 dòng cho 5 request được nhận.
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM recognitions").get().n, 5);

    provider.open();
    assert.ok(
      await waitFor(() => t.app.db.prepare("SELECT COUNT(*) AS n FROM recognitions WHERE status='pending'").get().n === 0, {
        label: "5 job nền chạy hết",
      }),
    );
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});
