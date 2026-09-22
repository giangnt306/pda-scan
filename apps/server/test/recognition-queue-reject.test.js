/* Nhánh "HÀNG ĐỢI TỪ CHỐI SLOT" — nhánh mà trước file này chưa một test nào chạy qua.
 *
 * `recognition-async.test.js` đặt `recognitionMaxWaitMs: 60000`, nên `await slot` trong
 * `runAsync()` chưa bao giờ bị TỪ CHỐI trong lúc test. Hai lỗi chặn nằm đúng ở đó:
 *   - job bị từ chối slot không được ghi `failed` vào DB ⇒ dòng `recognitions` nằm `pending`
 *     vĩnh viễn và PDA treo ở "Đang đọc nhãn…";
 *   - job bị từ chối slot vẫn gọi `semaphore.release()` ⇒ nhả một slot chưa từng chiếm, đẩy
 *     một job khác chạy song song và vượt `RECOGNITION_MAX_CONCURRENT`.
 *
 * Mọi test ở đây đặt `recognitionMaxWaitMs` NHỎ để nhánh đó thật sự chạy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "../src/recognition/semaphore.js";
import { startTestApp, upload, getJson, waitFor, JPEG } from "./helpers.js";

/* Provider có cổng chặn + ĐẾM ĐỈNH số lượt chạy đồng thời.
 *
 * Đỉnh đo tại provider là thước đo độc lập DUY NHẤT cho trần đồng thời:
 * `/api/status.queue.recognitionsInflight` lấy số từ chính semaphore, nên khi semaphore đếm
 * sai thì nó cũng báo sai y hệt — không dùng nó để tự chứng minh mình được. */
function peakProvider() {
  let inflight = 0;
  let peak = 0;
  let started = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  return {
    name: "mock",
    get peak() {
      return peak;
    },
    get started() {
      return started;
    },
    open: () => release(),
    async recognize({ signal }) {
      inflight += 1;
      started += 1;
      peak = Math.max(peak, inflight);
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

const countWhere = (t, sql) => t.app.db.prepare(`SELECT COUNT(*) AS n FROM recognitions WHERE ${sql}`).get().n;
const busyFailed = (t) => countWhere(t, "status='failed' AND error_code='RECOGNITION_BUSY'");

/* Cấu hình chung của ba test HTTP: một chỗ chạy, chỗ chờ rộng rãi, hạn chờ 150 ms.
 * `recognitionTimeoutMs` để rộng vì job đang chạy bị giữ ở cổng chặn cho tới khi test mở. */
const queueConfig = {
  recognitionMaxConcurrent: 1,
  recognitionMaxWaiting: 5,
  recognitionMaxWaitMs: 150,
  recognitionTimeoutMs: 8000,
};

test("chế độ async: job chờ quá RECOGNITION_MAX_WAIT_MS được ghi failed|RECOGNITION_BUSY vào DB, không nằm pending vĩnh viễn", async () => {
  const provider = peakProvider();
  const t = await startTestApp({ recognitionMode: "async", ...queueConfig }, { provider });
  try {
    const res = await Promise.all([upload(t.base, JPEG), upload(t.base, JPEG), upload(t.base, JPEG)]);
    for (const r of res) assert.equal(r.status, 202, `cả ba upload đều phải được nhận: ${res.map((x) => x.status)}`);

    /* Dừng chờ ở CẢ HAI kết cục để lỗi hiện ra ngay thay vì sau 5 giây hết giờ:
     * `started > 1` là dấu hiệu slot bị nhả nhầm, `busyFailed === 2` là kết cục đúng. */
    await waitFor(() => provider.started > 1 || busyFailed(t) === 2, {
      label: "hai job hết hạn chờ được ghi failed",
    });
    assert.equal(
      busyFailed(t),
      2,
      "job hết hạn chờ trong hàng đợi vẫn nằm pending — không ai ghi failed vào DB, PDA sẽ treo ở «Đang đọc nhãn…»",
    );
    assert.equal(countWhere(t, "status='pending'"), 1, "chỉ job đang thật sự chạy được phép còn pending");

    const rows = t.app.db
      .prepare("SELECT id, error_message, duration_ms, finished_at FROM recognitions WHERE status='failed' ORDER BY rowid")
      .all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.finished_at, "failed mà finished_at NULL thì màn hình giám sát vẫn coi là đang chạy");
      assert.equal(typeof row.duration_ms, "number", "duration_ms phải là số (thời gian nằm hàng đợi)");
      assert.match(row.error_message, /hàng đợi/, `error_message phải nói rõ lý do là hàng đợi: ${row.error_message}`);
    }

    // Đúng thứ PDA đọc được ở nhịp poll kế tiếp.
    const polled = await getJson(t.base, `/api/recognitions/${rows[0].id}`);
    assert.equal(polled.status, 200, "GET /api/recognitions/:id của một lượt thất bại vẫn là 200 (QUYẾT ĐỊNH A-3)");
    assert.equal(polled.body.status, "failed");
    assert.equal(polled.body.error.code, "RECOGNITION_BUSY");
    assert.equal(polled.body.fields, null);
    assert.ok(polled.body.finishedAt);

    // Và đúng thứ màn hình giám sát đọc được.
    const events = await getJson(t.base, "/api/admin/events?since=0&limit=200");
    const ids = new Set(rows.map((r) => r.id));
    const failedEvents = events.body.items.filter((e) => e.type === "recognition.failed" && ids.has(e.recognitionId));
    assert.equal(failedEvents.length, 2, "mỗi job bị từ chối slot phải để lại đúng một dòng recognition.failed trên sổ sự kiện");
    for (const ev of failedEvents) assert.equal(ev.detail.code, "RECOGNITION_BUSY");

    provider.open();
    await waitFor(() => countWhere(t, "status='pending'") === 0, { label: "job đang chạy kết thúc" });
    const status = await getJson(t.base, "/api/status");
    assert.equal(status.body.queue.recognitionsPending, 0, "không dòng recognitions nào được phép kết thúc ở trạng thái pending");
    assert.equal(countWhere(t, "status='completed'"), 1);
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});

test("chế độ async: job bị từ chối slot KHÔNG nhả slot của người khác — provider không bao giờ chạy quá RECOGNITION_MAX_CONCURRENT lượt cùng lúc", async () => {
  const provider = peakProvider();
  const t = await startTestApp({ recognitionMode: "async", ...queueConfig }, { provider });
  try {
    const res = await Promise.all(Array.from({ length: 4 }, () => upload(t.base, JPEG)));
    assert.deepEqual(
      res.map((r) => r.status),
      [202, 202, 202, 202],
      "sức chứa là 1 + 5 nên cả bốn phải được nhận",
    );

    await waitFor(() => provider.peak > 1 || busyFailed(t) === 3, { label: "ba job hết hạn chờ được ghi failed" });
    assert.equal(
      provider.peak,
      1,
      "hai lượt nhận dạng chạy đồng thời trong khi RECOGNITION_MAX_CONCURRENT = 1: một slot đã bị nhả bởi job chưa hề chiếm được nó",
    );
    assert.equal(provider.started, 1, "chỉ job chiếm được slot mới được phép gọi provider");
    assert.equal(busyFailed(t), 3);

    const during = await getJson(t.base, "/api/status");
    assert.equal(during.body.queue.recognitionsInflight, 1, "đúng một job đang chạy");
    assert.equal(during.body.queue.recognitionsWaiting, 0, "người chờ bị từ chối phải rời hàng đợi");

    provider.open();
    await waitFor(() => countWhere(t, "status='pending'") === 0, { label: "job đang chạy kết thúc" });
    const after = await getJson(t.base, "/api/status");
    assert.equal(after.body.queue.recognitionsInflight, 0, "nhả slot thừa một lần là inflight tụt xuống dưới 0 và kẹt ở đó");

    /* Semaphore còn dùng được SAU một vòng từ chối: đây là chỗ lỗi kế toán slot lộ ra —
     * nhả thừa sẽ làm upload tiếp theo chạy song song, nhả thiếu làm nó kẹt mãi. */
    const again = await upload(t.base, JPEG);
    assert.equal(again.status, 202);
    await waitFor(() => countWhere(t, "status='completed'") === 2, { label: "upload sau vòng từ chối vẫn chạy xong" });
    assert.equal(provider.peak, 1, "không lúc nào được có quá 1 lượt chạy đồng thời");
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});

test("chế độ sync: upload bị từ chối slot nhận 429 và KHÔNG nhả slot của người khác — trần đồng thời vẫn đúng 1", async () => {
  const provider = peakProvider();
  const t = await startTestApp(queueConfig, { provider });
  try {
    assert.equal(t.config.recognitionMode, "sync", "test này khoá nhánh ĐỒNG BỘ, không phải async");

    /* Ghi lại mã trạng thái NGAY khi từng response về: response của upload đang chạy chỉ tới
     * sau khi mở cổng, nên không thể `await Promise.all` trước khi kiểm. */
    const settled = [];
    const calls = Array.from({ length: 3 }, () =>
      upload(t.base, JPEG).then((r) => {
        settled.push(r.status);
        return r;
      }),
    );
    const busyCount = () => settled.filter((s) => s === 429).length;

    await waitFor(() => provider.started > 1 || busyCount() === 2, { label: "hai upload xếp hàng nhận 429 sau khi hết hạn chờ" });
    assert.equal(provider.peak, 1, "một upload bị 429 đã nhả slot của upload đang chạy");
    assert.equal(busyCount(), 2, "hai upload chờ quá RECOGNITION_MAX_WAIT_MS phải nhận 429");

    provider.open();
    const all = await Promise.all(calls);
    assert.equal(all.filter((r) => r.status === 201).length, 1, "đúng một upload chạy tới nơi");
    for (const r of all.filter((r) => r.status === 429)) assert.equal(r.body.error.code, "RECOGNITION_BUSY");
    // Q11: 429 không để lại ảnh và không để lại dòng DB nào.
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM recognitions").get().n, 1);
  } finally {
    provider.open();
    await t.stop();
    t.cleanup();
  }
});

test("semaphore: mọi người chờ quá maxWaitMs đều bị từ chối và rời hàng đợi, kế toán slot không lệch", async () => {
  const s = createSemaphore({ maxConcurrent: 1, maxWaiting: 5, maxWaitMs: 60 });
  await s.acquire(null); // chiếm slot duy nhất
  const waiters = [s.acquire(null), s.acquire(null)];
  assert.deepEqual(s.stats(), { inflight: 1, waiting: 2 });

  /* Hẹn giờ hết hạn chờ của semaphore là `.unref()` — đúng, nó không được phép giữ tiến trình
   * sống. Trong test thì không có socket nào giữ vòng lặp sự kiện, nên phải tự giữ. */
  const keepAlive = setInterval(() => {}, 10);
  const results = await Promise.allSettled(waiters).finally(() => clearInterval(keepAlive));
  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected"],
    "cả hai người chờ phải bị từ chối khi hết maxWaitMs, không chỉ người đầu",
  );
  for (const r of results) {
    assert.equal(r.reason.code, "RECOGNITION_BUSY");
    assert.equal(r.reason.status, 429);
  }
  assert.deepEqual(s.stats(), { inflight: 1, waiting: 0 }, "người bị từ chối phải rời hàng đợi, không giữ chỗ cho một request đã chết");

  s.release(); // người đang GIỮ slot trả slot
  assert.deepEqual(s.stats(), { inflight: 0, waiting: 0 });
  assert.equal(s.canAdmit(), true);

  await s.acquire(null); // xin lại được ngay: không có slot nào bị bỏ quên
  assert.deepEqual(s.stats(), { inflight: 1, waiting: 0 });
  s.release();
  assert.deepEqual(s.stats(), { inflight: 0, waiting: 0 });
});
