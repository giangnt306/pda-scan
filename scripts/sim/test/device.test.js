import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createDevice } from "../lib/device.js";
import { createStats } from "../lib/fleet.js";
import { JPEG_1X1 } from "../lib/fixtures.js";

/* Máy chủ giả trên cổng 0, dựng trong chính file test này (không cần Main Backend thật).
 * `plan` là danh sách phản hồi cho POST /api/receipts theo thứ tự; hết plan thì trả 201. */
function fakeServer(plan) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const step = plan.shift() ?? { status: 201, body: { id: "r", idempotent: false } };
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify(step.body ?? {}));
    });
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

const options = (base) => ({
  base,
  devices: 1,
  rate: 6,
  duration: 0,
  failRate: 0,
  recognize: false,
  recognizeOnly: false,
  uploads: 0,
  sameLabel: false,
  prefix: "T",
  seed: 1,
  heartbeat: 15000,
  warehouse: "WH01",
  shift: "sang",
  noSession: true,
  image: null,
});

const makeDevice = (base, stats) =>
  createDevice({
    index: 0,
    options: options(base),
    image: { buffer: JPEG_1X1, mimeType: "image/jpeg", name: "x.jpg" },
    location: "A-01-01",
    stats,
    log: null,
    retryDelayMs: 10,
  });

test("503 BACKEND_DOWN_SIMULATED: thiết bị thử lại với ĐÚNG requestId cũ và tăng counter.blocked", async () => {
  const { server, seen } = fakeServer([
    { status: 503, body: { error: { code: "BACKEND_DOWN_SIMULATED", message: "down", details: { retryAfterMs: 5000 } } } },
    { status: 503, body: { error: { code: "BACKEND_DOWN_SIMULATED", message: "down", details: { retryAfterMs: 5000 } } } },
    { status: 201, body: { id: "r-1", idempotent: false } },
  ]);
  const base = await listen(server);
  after(() => server.close());

  const stats = createStats();
  const saved = await makeDevice(base, stats).saveOnce();

  assert.equal(saved, true);
  assert.equal(seen.length, 3);
  const ids = seen.map((r) => r.body.requestId);
  assert.equal(new Set(ids).size, 1, "thử lại phải dùng lại requestId cũ — đó là khoá idempotency của BE");
  assert.equal(stats.counters.blocked, 2);
  assert.equal(stats.counters.saved, 1);
  assert.equal(stats.counters.otherError, 0);
  // Một phiếu = một requestId trong sổ, dù đã gửi 3 lần.
  assert.equal(stats.requestIds.length, 1);
  assert.deepEqual(stats.duplicateRequestIds(), []);
});

test("mỗi attempt mang một x-request-id MỚI trong khi body.requestId giữ nguyên", async () => {
  const { server, seen } = fakeServer([
    { status: 503, body: { error: { code: "BACKEND_READONLY", message: "ro", details: { retryAfterMs: 5000 } } } },
    { status: 201, body: { id: "r-2", idempotent: false } },
  ]);
  const base = await listen(server);
  after(() => server.close());

  await makeDevice(base, createStats()).saveOnce();

  assert.equal(seen.length, 2);
  const traceIds = seen.map((r) => r.headers["x-request-id"]);
  assert.equal(new Set(traceIds).size, 2, "x-request-id là dấu vết của MỘT lần gửi, phải khác nhau mỗi attempt");
  assert.equal(seen[0].body.requestId, seen[1].body.requestId);
  assert.equal(seen[0].headers["x-app-version"], "sim-0.5.0");
  assert.ok(seen[0].headers["x-device-id"]);
});

test("409 DUPLICATE_LABEL: thiết bị gửi lại NGAY với requestId MỚI và allowDuplicate=true", async () => {
  const { server, seen } = fakeServer([
    { status: 409, body: { error: { code: "DUPLICATE_LABEL", message: "trùng", details: {} } } },
    { status: 201, body: { id: "r-3", idempotent: false } },
  ]);
  const base = await listen(server);
  after(() => server.close());

  const stats = createStats();
  const saved = await makeDevice(base, stats).saveOnce();

  assert.equal(saved, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body.allowDuplicate, undefined);
  assert.equal(seen[1].body.allowDuplicate, true);
  assert.notEqual(seen[1].body.requestId, seen[0].body.requestId, "nhánh 409 là ngoại lệ DUY NHẤT được đổi requestId");
  assert.equal(stats.counters.duplicate, 1);
  assert.equal(stats.counters.saved, 1);
  assert.equal(stats.requestIds.length, 2);
});

test("422 VALIDATION_FAILED: thiết bị bỏ phiếu và KHÔNG thử lại", async () => {
  const { server, seen } = fakeServer([
    { status: 422, body: { error: { code: "VALIDATION_FAILED", message: "sai", details: { fields: {} } } } },
  ]);
  const base = await listen(server);
  after(() => server.close());

  const stats = createStats();
  const saved = await makeDevice(base, stats).saveOnce();

  assert.equal(saved, false);
  assert.equal(seen.length, 1, "422 là dữ liệu sai, gửi lại y hệt sẽ sai y hệt");
  assert.equal(stats.counters.invalid, 1);
  assert.equal(stats.counters.saved, 0);
  assert.equal(stats.counters.blocked, 0);
});

test("200 (idempotent) được đếm vào cả saved lẫn idempotent, không phải một lần lưu mới", async () => {
  const { server } = fakeServer([{ status: 200, body: { id: "r-4", idempotent: true } }]);
  const base = await listen(server);
  after(() => server.close());

  const stats = createStats();
  await makeDevice(base, stats).saveOnce();

  assert.equal(stats.counters.saved, 1);
  assert.equal(stats.counters.idempotent, 1);
});

test("stats.bump với tên bộ đếm gõ sai NÉM lỗi thay vì lặng lẽ tạo bộ đếm mới", () => {
  const stats = createStats();
  assert.throws(() => stats.bump("blockd"), /Bộ đếm không hiểu: blockd/);
  assert.equal(stats.counters.blocked, 0);
});

/* ---------- Chế độ bất đồng bộ: 202 + thăm dò --------------------------------------------- */

/**
 * Máy chủ giả cho ĐÚNG đường async: POST /api/recognitions trả 202 + recognitionId,
 * GET /api/recognitions/:id trả lần lượt các trạng thái trong `statuses`.
 */
function fakeAsyncRecognitionServer(statuses) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url });
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/recognitions") {
        return send(202, { recognitionId: "rec-1", status: "pending", pollUrl: "/api/recognitions/rec-1", pollAfterMs: 0 });
      }
      if (req.method === "GET" && req.url === "/api/recognitions/rec-1") {
        const next = statuses.shift() ?? "completed";
        return send(200, next === "completed" ? { status: "completed", recognitionId: "rec-1", fields: {} } : { status: next });
      }
      return send(404, { error: { code: "NOT_FOUND" } });
    });
  });
  return { server, seen };
}

test("202 + thăm dò: thiết bị chỉ kết thúc khi trạng thái DỨT KHOÁT về, và tăng recognizeAccepted202 + recognizePolls", async () => {
  const { server, seen } = fakeAsyncRecognitionServer(["pending", "pending", "completed"]);
  const base = await listen(server);
  const stats = createStats();
  try {
    const out = await makeDevice(base, stats).recognizeOnce();
    assert.deepEqual(out, { recognitionId: "rec-1", fields: {} });
  } finally {
    server.close();
  }

  // Bằng chứng đã đi ĐƯỜNG BẤT ĐỒNG BỘ, không phải 201 đồng bộ.
  assert.equal(stats.counters.recognizeAccepted202, 1);
  // Hai lần "pending" không được coi là xong: phải thăm dò đủ 3 lần mới tới "completed".
  assert.equal(stats.counters.recognizePolls, 3);
  assert.equal(seen.filter((r) => r.method === "GET").length, 3);
  assert.equal(stats.counters.recognizeOk, 1);
  assert.equal(stats.counters.recognizeFailed, 0);
  assert.equal(stats.counters.otherError, 0);
});

test('202 rồi trạng thái "failed": đếm vào recognizeFailed chứ KHÔNG phải recognizeOk, và vẫn ghi nhận đã đi đường 202', async () => {
  const { server } = fakeAsyncRecognitionServer(["pending", "failed"]);
  const base = await listen(server);
  const stats = createStats();
  try {
    const out = await makeDevice(base, stats).recognizeOnce();
    assert.equal(out, null);
  } finally {
    server.close();
  }
  assert.equal(stats.counters.recognizeAccepted202, 1);
  assert.equal(stats.counters.recognizePolls, 2);
  assert.equal(stats.counters.recognizeFailed, 1);
  assert.equal(stats.counters.recognizeOk, 0);
  /* "failed" là KẾT QUẢ nghiệp vụ trả về trong HTTP 200, không phải sự cố ngoài kịch bản. */
  assert.equal(stats.counters.otherError, 0);
});

test("đường đồng bộ (201) KHÔNG tăng recognizeAccepted202 — nếu tăng thì bộ đếm này vô dụng để phân biệt hai chế độ", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ recognitionId: "rec-sync", status: "completed", fields: {} }));
    });
  });
  const base = await listen(server);
  const stats = createStats();
  try {
    const out = await makeDevice(base, stats).recognizeOnce();
    assert.equal(out.recognitionId, "rec-sync");
  } finally {
    server.close();
  }
  assert.equal(stats.counters.recognizeAccepted202, 0);
  assert.equal(stats.counters.recognizePolls, 0);
  assert.equal(stats.counters.recognizeOk, 1);
});
