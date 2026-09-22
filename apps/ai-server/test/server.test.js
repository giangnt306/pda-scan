import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const silent = { info() {}, warn() {}, error() {} };

async function start(overrides, fetchImpl) {
  const config = loadConfig({ dotenv: false, apiKey: "k", ...overrides });
  const server = createServer(config, { fetchImpl, logger: silent });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, stop: () => new Promise((r) => server.close(r)) };
}

const upload = async (base, buf, headers = {}) => {
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "image/jpeg" }), "a.jpg");
  form.append("recognitionId", "rid-1");
  const res = await fetch(`${base}/recognize`, { method: "POST", body: form, headers });
  return { status: res.status, body: await res.json() };
};

const okLlm = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "m", choices: [{ message: { content: JSON.stringify({ fields: [{ name: "qty", text: "80", score: 0.9 }], raw_text: "QTY 80" }) } }] }) });

test("health + recognize trả contract chuẩn", async () => {
  const s = await start({}, okLlm);
  try {
    const h = await (await fetch(`${s.base}/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.configured, true);
    const { status, body } = await upload(s.base, JPEG);
    assert.equal(status, 200);
    assert.equal(body.recognitionId, "rid-1");
    assert.equal(body.fields.find((f) => f.name === "qty").text, "80");
    assert.equal(body.rawText, "QTY 80");
    assert.equal(typeof body.durationMs, "number");
  } finally {
    await s.stop();
  }
});

test("lỗi đầu vào: không phải ảnh 415, thiếu field 400, quá lớn 413, sai method 405", async () => {
  const s = await start({ maxUploadBytes: 100 }, okLlm);
  try {
    assert.equal((await upload(s.base, Buffer.from("hello hello hello"))).body.error.code, "UNSUPPORTED_IMAGE");
    assert.equal((await upload(s.base, JPEG)).body.error.code, "IMAGE_TOO_LARGE");
    const form = new FormData();
    form.append("other", "x");
    assert.equal((await (await fetch(`${s.base}/recognize`, { method: "POST", body: form })).json()).error.code, "IMAGE_REQUIRED");
    assert.equal((await fetch(`${s.base}/recognize`)).status, 405);
  } finally {
    await s.stop();
  }
});

test("shared secret: thiếu → 401, đúng → 200", async () => {
  const s = await start({ sharedSecret: "s3cret" }, okLlm);
  try {
    assert.equal((await upload(s.base, JPEG)).status, 401);
    assert.equal((await upload(s.base, JPEG, { authorization: "Bearer s3cret" })).status, 200);
  } finally {
    await s.stop();
  }
});

test("chưa có key → 503 NOT_CONFIGURED; LLM 429 → 502 kèm upstreamStatus", async () => {
  const s1 = await start({ apiKey: "" });
  try {
    const r = await upload(s1.base, JPEG);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, "NOT_CONFIGURED");
  } finally {
    await s1.stop();
  }
  const s2 = await start({}, async () => ({ ok: false, status: 429, text: async () => "rate limited" }));
  try {
    const r = await upload(s2.base, JPEG);
    assert.equal(r.status, 502);
    assert.equal(r.body.error.upstreamStatus, 429);
  } finally {
    await s2.stop();
  }
});

/* ---- Phase 3: truy vết x-request-id + /health mở rộng (chỉ THÊM, không sửa 4 test trên) ---- */

test("x-request-id: gửi lên thì trả lại đúng giá trị trong header và trong body.requestId; không gửi thì server tự sinh", async () => {
  const s = await start({}, okLlm);
  try {
    const form = new FormData();
    form.append("image", new Blob([JPEG], { type: "image/jpeg" }), "a.jpg");
    form.append("recognitionId", "rid-1");
    const res = await fetch(`${s.base}/recognize`, { method: "POST", body: form, headers: { "x-request-id": "acc-e4-000001" } });
    const body = await res.json();
    // ⚠️ sendJson dùng writeHead(status, {...}); test này chứng minh header setHeader trước đó vẫn còn.
    assert.equal(res.headers.get("x-request-id"), "acc-e4-000001");
    assert.equal(body.requestId, "acc-e4-000001");
    assert.equal(body.simMode, "passthrough");
    assert.equal(body.retryCount, 0);
    assert.equal(body.model, "m");

    // Không gửi → server tự sinh, header và body khớp nhau.
    const auto = await upload(s.base, JPEG);
    assert.equal(typeof auto.body.requestId, "string");
    assert.equal(auto.body.requestId.length >= 8, true);

    const res2 = await fetch(`${s.base}/recognize`, { method: "POST", body: (() => { const f = new FormData(); f.append("image", new Blob([JPEG], { type: "image/jpeg" }), "a.jpg"); return f; })() });
    const b2 = await res2.json();
    assert.equal(res2.headers.get("x-request-id"), b2.requestId);

    // Cả response lỗi cũng phải mang x-request-id (404, 405…).
    const nf = await fetch(`${s.base}/khong-co`, { headers: { "x-request-id": "acc-e4-000002" } });
    assert.equal(nf.status, 404);
    assert.equal(nf.headers.get("x-request-id"), "acc-e4-000002");
    const h = await fetch(`${s.base}/health`, { headers: { "x-request-id": "acc-e4-000003" } });
    assert.equal(h.headers.get("x-request-id"), "acc-e4-000003");
  } finally {
    await s.stop();
  }
});

test("GET /health trả simMode, upstreamTimeoutMs và ready, giữ nguyên các field cũ", async () => {
  const s = await start({ ocrSimMode: "partial", upstreamTimeoutMs: 18000 }, okLlm);
  try {
    const h = await (await fetch(`${s.base}/health`)).json();
    // BE probe đọc configured, ready và model — không được đổi tên/kiểu.
    assert.deepEqual(Object.keys(h).sort(), ["authRequired", "baseUrl", "configured", "model", "ok", "ready", "simMode", "upstreamTimeoutMs"]);
    assert.equal(h.ok, true);
    assert.equal(h.configured, true);
    assert.equal(h.ready, true);
    assert.equal(h.authRequired, false);
    assert.equal(h.model, "gpt-4o-mini");
    assert.equal(h.baseUrl, "https://api.openai.com/v1");
    assert.equal(h.simMode, "partial");
    assert.equal(h.upstreamTimeoutMs, 18000);
  } finally {
    await s.stop();
  }
});

/* ---- ĐÍNH CHÍNH R7: ready = "có phục vụ được /recognize không", tách khỏi configured ---- */

test("KHÔNG có OPENAI_API_KEY + OCR_SIM_MODE=partial → /health trả ready: true, configured: false, và /recognize vẫn trả 200", async () => {
  // fetch giả ném lỗi: chứng minh đường này không hề chạm tới LLM.
  const s = await start({ apiKey: "", ocrSimMode: "partial" }, async () => {
    throw new Error("mode mô phỏng không được gọi mạng");
  });
  try {
    const h = await (await fetch(`${s.base}/health`)).json();
    assert.equal(h.configured, false, "không có OPENAI_API_KEY → configured phải false");
    assert.equal(h.ready, true, "vẫn phục vụ được /recognize → ready phải true");
    assert.equal(h.simMode, "partial");
    assert.equal(h.upstreamTimeoutMs, 18000);
    // ready phải khớp SỰ THẬT: đúng cấu hình đó, /recognize trả 201-class (200), không phải 503.
    const { status, body } = await upload(s.base, JPEG);
    assert.equal(status, 200);
    assert.equal(body.model, "sim-partial");
  } finally {
    await s.stop();
  }
});

test("ready = configured HOẶC simMode khác passthrough — 4 tổ hợp key × simMode, và 503 NOT_CONFIGURED chỉ xảy ra đúng khi ready = false", async () => {
  const cases = [
    { apiKey: "", ocrSimMode: "passthrough", configured: false, ready: false },
    { apiKey: "", ocrSimMode: "garbage", configured: false, ready: true },
    { apiKey: "k", ocrSimMode: "passthrough", configured: true, ready: true },
    { apiKey: "k", ocrSimMode: "error", configured: true, ready: true },
  ];
  for (const c of cases) {
    const label = `key=${c.apiKey ? "có" : "không"} simMode=${c.ocrSimMode}`;
    const s = await start({ apiKey: c.apiKey, ocrSimMode: c.ocrSimMode }, okLlm);
    try {
      const h = await (await fetch(`${s.base}/health`)).json();
      assert.equal(h.configured, c.configured, `${label}: configured`);
      assert.equal(h.ready, c.ready, `${label}: ready`);
      const { status, body } = await upload(s.base, JPEG);
      assert.equal(status === 503 && body.error.code === "NOT_CONFIGURED", !c.ready, `${label}: ready phải khớp với việc /recognize có phục vụ được không`);
    } finally {
      await s.stop();
    }
  }
});
