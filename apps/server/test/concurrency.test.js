import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startTestApp, upload, getJson, JPEG } from "./helpers.js";

/* Provider giả có cổng chặn: test tự quyết định khi nào một lần nhận dạng kết thúc, nhờ vậy
 * kiểm được số lượng chạy đồng thời mà không phụ thuộc vào đồng hồ. */
function gatedProvider({ autoDelayMs = null } = {}) {
  let inflight = 0;
  let maxInflight = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  return {
    name: "mock",
    get inflight() {
      return inflight;
    },
    get maxInflight() {
      return maxInflight;
    },
    open: () => release(),
    async recognize({ signal }) {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        if (autoDelayMs === null) {
          await Promise.race([
            gate,
            new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
          ]);
        } else {
          await new Promise((r) => setTimeout(r, autoDelayMs));
        }
        return { raw: { model: "gated" }, fields: { partNumber: { value: "BEX32181030AB", confidence: 0.9 } } };
      } finally {
        inflight -= 1;
      }
    },
  };
}

/* Chờ tới khi semaphore đạt trạng thái mong muốn, tránh sleep cố định gây bong tróc test. */
async function waitFor(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test("semaphore: 6 upload song song với mock slow → tối đa 3 chạy đồng thời", async () => {
  const provider = gatedProvider();
  const t = await startTestApp({ recognitionMaxConcurrent: 3, recognitionTimeoutMs: 10000 }, { provider });
  try {
    const calls = Array.from({ length: 6 }, () => upload(t.base, JPEG));
    assert.ok(await waitFor(() => provider.inflight === 3), "phải có đúng 3 lần chạy đồng thời");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(provider.inflight, 3, "không được vượt RECOGNITION_MAX_CONCURRENT");
    provider.open();
    const results = await Promise.all(calls);
    assert.equal(results.filter((r) => r.status === 201).length, 6);
    assert.equal(provider.maxInflight, 3);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("hàng đợi đầy: 3 inflight + 10 waiting → request thứ 14 nhận 429 RECOGNITION_BUSY kèm retryAfterMs và header retry-after", async () => {
  const provider = gatedProvider();
  const t = await startTestApp(
    { recognitionMaxConcurrent: 3, recognitionMaxWaiting: 10, recognitionMaxWaitMs: 20000, recognitionTimeoutMs: 20000 },
    { provider },
  );
  try {
    const calls = Array.from({ length: 13 }, () => upload(t.base, JPEG));
    assert.ok(
      await waitFor(async () => {
        const q = (await getJson(t.base, "/api/status")).body.queue;
        return q.recognitionsInflight === 3 && q.recognitionsWaiting === 10;
      }),
      "13 request đầu phải lấp đầy 3 slot chạy + 10 chỗ chờ",
    );

    const busy = await upload(t.base, JPEG);
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error.code, "RECOGNITION_BUSY");
    assert.equal(busy.body.error.message, "Máy chủ đang xử lý nhiều ảnh, hãy thử lại sau ít giây");
    assert.equal(busy.body.error.details.retryAfterMs, 3000);
    assert.equal(busy.body.error.details.inflight, 3);
    assert.equal(busy.body.error.details.waiting, 10);
    assert.equal(busy.body.error.details.recognitionId, undefined, "chưa có recognition nào được tạo");
    assert.equal(busy.headers.get("retry-after"), "3");

    provider.open();
    const results = await Promise.all(calls);
    assert.equal(results.filter((r) => r.status === 201).length, 13);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("429 RECOGNITION_BUSY không tạo dòng recognitions và không lưu file ảnh nào", async () => {
  const provider = gatedProvider();
  const t = await startTestApp(
    { recognitionMaxConcurrent: 1, recognitionMaxWaiting: 0, recognitionTimeoutMs: 20000 },
    { provider },
  );
  try {
    const running = upload(t.base, JPEG);
    assert.ok(await waitFor(() => provider.inflight === 1));

    const countRows = () => t.app.db.prepare("SELECT COUNT(*) AS n FROM recognitions").get().n;
    const countImages = () => t.app.db.prepare("SELECT COUNT(*) AS n FROM images").get().n;
    const rowsBefore = countRows();
    const imagesBefore = countImages();
    const filesBefore = fs.readdirSync(t.config.uploadsDir).length;

    const busy = await upload(t.base, JPEG);
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error.code, "RECOGNITION_BUSY");
    assert.equal(countRows(), rowsBefore, "xin slot TRƯỚC khi lưu ảnh (Q11): không thêm dòng recognitions");
    assert.equal(countImages(), imagesBefore, "không thêm dòng images");
    assert.equal(fs.readdirSync(t.config.uploadsDir).length, filesBefore, "không để lại file ảnh nào trên đĩa");

    provider.open();
    assert.equal((await running).status, 201);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("status.queue phản ánh inflight/waiting trong lúc đang tải", async () => {
  const provider = gatedProvider();
  const t = await startTestApp(
    { recognitionMaxConcurrent: 1, recognitionMaxWaiting: 5, recognitionMaxWaitMs: 20000, recognitionTimeoutMs: 20000 },
    { provider },
  );
  try {
    const idle = (await getJson(t.base, "/api/status")).body.queue;
    /* Phase 5 thêm 2 khoá vào status.queue (02-contracts-api.md §2.1). deepEqual giữ nguyên để
     * một khoá lạ thứ sáu vẫn làm test đỏ — chỉ cập nhật đúng hai khoá đã được hợp đồng khai. */
    assert.deepEqual(idle, {
      recognitionsInflight: 0,
      recognitionsWaiting: 0,
      outboxPending: 0,
      recognitionsPending: 0,
      recognitionsFailedRecent: 0,
    });

    const calls = [upload(t.base, JPEG), upload(t.base, JPEG)];
    assert.ok(
      await waitFor(async () => {
        const q = (await getJson(t.base, "/api/status")).body.queue;
        return q.recognitionsInflight === 1 && q.recognitionsWaiting === 1;
      }),
      "status phải thấy 1 đang chạy + 1 đang chờ",
    );

    provider.open();
    await Promise.all(calls);
    assert.ok(
      await waitFor(async () => {
        const q = (await getJson(t.base, "/api/status")).body.queue;
        return q.recognitionsInflight === 0 && q.recognitionsWaiting === 0;
      }),
      "xong thì hàng đợi phải rỗng lại",
    );
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("client ngắt kết nối khi đang XẾP HÀNG → rời hàng đợi, trả chỗ, request kế tiếp được phục vụ thay vì 429", async () => {
  const provider = gatedProvider();
  // Đúng 1 slot chạy + 1 chỗ chờ: nếu chỗ chờ không được trả lại thì request thứ ba chắc chắn 429.
  const t = await startTestApp(
    { recognitionMaxConcurrent: 1, recognitionMaxWaiting: 1, recognitionMaxWaitMs: 20000, recognitionTimeoutMs: 20000 },
    { provider },
  );
  try {
    const running = upload(t.base, JPEG);
    assert.ok(await waitFor(() => provider.inflight === 1), "request thứ nhất phải chiếm slot");

    const ctrl = new AbortController();
    const queued = upload(t.base, JPEG, { signal: ctrl.signal }).catch((err) => err);
    assert.ok(
      await waitFor(async () => (await getJson(t.base, "/api/status")).body.queue.recognitionsWaiting === 1),
      "request thứ hai phải đang chờ trong hàng đợi",
    );

    ctrl.abort();
    await queued;
    assert.ok(
      await waitFor(async () => (await getJson(t.base, "/api/status")).body.queue.recognitionsWaiting === 0),
      "client bỏ đi thì chỗ chờ phải được trả lại ngay, không chờ hết RECOGNITION_MAX_WAIT_MS",
    );
    assert.equal(provider.inflight, 1, "request đã bỏ không được nhảy vào slot đang chạy");

    // Chỗ chờ đã trống: người đến sau được xếp hàng chứ không bị từ chối.
    const next = upload(t.base, JPEG);
    assert.ok(
      await waitFor(async () => (await getJson(t.base, "/api/status")).body.queue.recognitionsWaiting === 1),
      "request kế tiếp phải vào được hàng đợi",
    );

    provider.open();
    assert.equal((await running).status, 201);
    assert.equal((await next).status, 201, "request kế tiếp được phục vụ, không phải 429");
    assert.equal(provider.maxInflight, 1);

    // Request bị bỏ không được tính là đã chạy: provider chỉ được gọi cho 2 request thật.
    assert.ok(
      await waitFor(async () => {
        const q = (await getJson(t.base, "/api/status")).body.queue;
        return q.recognitionsInflight === 0 && q.recognitionsWaiting === 0;
      }),
      "xong thì semaphore phải rỗng hoàn toàn",
    );
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("client ngắt kết nối khi provider ĐANG CHẠY → huỷ lời gọi, trả slot ngay, không chờ hết RECOGNITION_TIMEOUT_MS", async () => {
  const provider = gatedProvider();
  const t = await startTestApp(
    { recognitionMaxConcurrent: 1, recognitionMaxWaiting: 0, recognitionTimeoutMs: 20000 },
    { provider },
  );
  try {
    const ctrl = new AbortController();
    const dropped = upload(t.base, JPEG, { signal: ctrl.signal }).catch((err) => err);
    assert.ok(await waitFor(() => provider.inflight === 1), "provider phải đang chạy");

    const t0 = Date.now();
    ctrl.abort();
    await dropped;
    assert.ok(
      await waitFor(async () => (await getJson(t.base, "/api/status")).body.queue.recognitionsInflight === 0),
      "slot phải được trả về ngay khi client bỏ đi",
    );
    assert.ok(Date.now() - t0 < 5000, `không được giữ slot tới hết timeout, đo được ${Date.now() - t0} ms`);
    assert.equal(provider.inflight, 0, "lời gọi provider phải bị huỷ, không chạy tiếp");

    // Slot đã rỗng: request mới được phục vụ ngay dù maxWaiting = 0.
    provider.open();
    assert.equal((await upload(t.base, JPEG)).status, 201);

    // Bản ghi của request bị bỏ được đánh dấu trung thực, không phải RECOGNITION_TIMEOUT.
    const row = t.app.db.prepare("SELECT status, error_code FROM recognitions WHERE error_code = 'CLIENT_ABORTED'").get();
    assert.ok(row, "phải có dòng recognitions ghi nhận client bỏ đi");
    assert.equal(row.status, "failed");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("chờ quá RECOGNITION_MAX_WAIT_MS trong hàng đợi → 429 RECOGNITION_BUSY (không phải 504)", async () => {
  const provider = gatedProvider();
  const t = await startTestApp(
    { recognitionMaxConcurrent: 1, recognitionMaxWaiting: 5, recognitionMaxWaitMs: 120, recognitionTimeoutMs: 20000 },
    { provider },
  );
  try {
    const running = upload(t.base, JPEG);
    assert.ok(await waitFor(() => provider.inflight === 1));

    const t0 = Date.now();
    const waited = await upload(t.base, JPEG);
    assert.ok(Date.now() - t0 >= 100, "phải thực sự chờ trong hàng đợi trước khi từ chối");
    assert.equal(waited.status, 429);
    assert.equal(waited.body.error.code, "RECOGNITION_BUSY");

    provider.open();
    assert.equal((await running).status, 201);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
