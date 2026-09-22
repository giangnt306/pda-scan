import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { OCR_SIM_MODES, PARTIAL_KEEP, GARBAGE_FIELDS_OVERRIDE, GARBAGE_RAW_TEXT, SIM_SAMPLE_FIELDS } from "../src/sim.js";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const silent = { info() {}, warn() {}, error() {} };

/* fetch giả dùng chung: mọi mode mô phỏng KHÔNG được gọi nó lần nào.
 * apiKey để rỗng ở mọi test dưới đây → chứng minh không cần OPENAI_API_KEY. */
function spyFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    throw new Error("Mode mô phỏng không được gọi mạng");
  };
  impl.calls = calls;
  return impl;
}

async function start(overrides, fetchImpl) {
  const config = loadConfig({ dotenv: false, apiKey: "", ...overrides });
  const server = createServer(config, { fetchImpl, logger: silent });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, stop: () => new Promise((r) => server.close(r)) };
}

const upload = async (base, headers = {}) => {
  const form = new FormData();
  form.append("image", new Blob([JPEG], { type: "image/jpeg" }), "a.jpg");
  form.append("recognitionId", "rid-sim");
  const res = await fetch(`${base}/recognize`, { method: "POST", body: form, headers });
  return { status: res.status, body: await res.json() };
};

test("OCR_SIM_MODE=partial: 200, đúng 4 trường có text (qty, part_name, batch, plant_dock), 6 trường text=null", async () => {
  const fetchImpl = spyFetch();
  const s = await start({ ocrSimMode: "partial" }, fetchImpl);
  try {
    const { status, body } = await upload(s.base);
    assert.equal(status, 200);
    assert.equal(body.simMode, "partial");
    assert.equal(body.model, "sim-partial");
    assert.equal(body.usage, null);
    assert.equal(body.fields.length, 10);
    // 4 trường PARTIAL_KEEP giữ NGUYÊN giá trị mẫu; 6 trường còn lại bị xoá.
    for (const name of PARTIAL_KEEP) {
      const got = body.fields.find((f) => f.name === name);
      const want = SIM_SAMPLE_FIELDS.find((f) => f.name === name);
      assert.deepEqual(got, want, `trường giữ lại: ${name}`);
    }
    const cleared = body.fields.filter((f) => !PARTIAL_KEEP.includes(f.name));
    assert.equal(cleared.length, 6);
    assert.equal(cleared.every((f) => f.text === null && f.score === 0), true);
    // plant_dock trong mẫu vốn đã null → tổng cộng 7 trường text=null (6 do partial xoá + plant_dock).
    assert.equal(body.fields.filter((f) => f.text === null).length, 7);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await s.stop();
  }
});

test("OCR_SIM_MODE=garbage: 200, part_number là chuỗi rác cố định, rawText là chuỗi rác", async () => {
  const fetchImpl = spyFetch();
  const s = await start({ ocrSimMode: "garbage" }, fetchImpl);
  try {
    const { status, body } = await upload(s.base);
    assert.equal(status, 200);
    assert.equal(body.simMode, "garbage");
    assert.equal(body.model, "sim-garbage");
    assert.equal(body.fields.length, 10);
    for (const [name, text] of Object.entries(GARBAGE_FIELDS_OVERRIDE)) {
      assert.equal(body.fields.find((f) => f.name === name).text, text);
    }
    assert.equal(body.rawText, GARBAGE_RAW_TEXT);
    // Trường không nằm trong danh sách rác vẫn giữ giá trị mẫu.
    assert.equal(body.fields.find((f) => f.name === "batch").text, "260917_79F");
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await s.stop();
  }
});

test("OCR_SIM_MODE=error: 502 UPSTREAM_ERROR kèm upstreamStatus 500", async () => {
  const fetchImpl = spyFetch();
  const s = await start({ ocrSimMode: "error" }, fetchImpl);
  try {
    const { status, body } = await upload(s.base);
    assert.equal(status, 502);
    assert.equal(body.error.code, "UPSTREAM_ERROR");
    assert.equal(body.error.upstreamStatus, 500);
    assert.match(body.error.message, /Mô phỏng/);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await s.stop();
  }
});

test("OCR_SIM_MODE=timeout: 504 UPSTREAM_TIMEOUT sau upstreamTimeoutMs, không gọi fetch lần nào", async () => {
  const fetchImpl = spyFetch();
  const s = await start({ ocrSimMode: "timeout", upstreamTimeoutMs: 120 }, fetchImpl);
  try {
    const t0 = Date.now();
    const { status, body } = await upload(s.base);
    const elapsed = Date.now() - t0;
    assert.equal(status, 504);
    assert.equal(body.error.code, "UPSTREAM_TIMEOUT");
    assert.equal(elapsed >= 100, true, `phải treo tới khi abort, đo được ${elapsed} ms`);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await s.stop();
  }
});

test("OCR_SIM_MODE=slow: trả 200 sau OCR_SIM_DELAY_MS; signal abort giữa chừng → 504", async () => {
  const fetchImpl = spyFetch();
  const ok = await start({ ocrSimMode: "slow", ocrSimDelayMs: 60, upstreamTimeoutMs: 5000 }, fetchImpl);
  try {
    const t0 = Date.now();
    const { status, body } = await upload(ok.base);
    assert.equal(status, 200);
    assert.equal(body.model, "sim-slow");
    assert.equal(Date.now() - t0 >= 55, true);
    assert.equal(body.fields.find((f) => f.name === "part_number").text, "BEX32181030AB");
  } finally {
    await ok.stop();
  }
  // delay dài hơn timeout → abort giữa chừng, đúng cảnh BE gặp khi ai-server chậm.
  const late = await start({ ocrSimMode: "slow", ocrSimDelayMs: 5000, upstreamTimeoutMs: 120 }, fetchImpl);
  try {
    const { status, body } = await upload(late.base);
    assert.equal(status, 504);
    assert.equal(body.error.code, "UPSTREAM_TIMEOUT");
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await late.stop();
  }
});

test("mọi mode mô phỏng chạy được KHÔNG cần OPENAI_API_KEY, KHÔNG gọi fetch, và /health báo ready: true dù configured: false", async () => {
  const fetchImpl = spyFetch();
  for (const mode of OCR_SIM_MODES.filter((m) => m !== "passthrough")) {
    const s = await start({ ocrSimMode: mode, ocrSimDelayMs: 20, upstreamTimeoutMs: 150, apiKey: "" }, fetchImpl);
    try {
      const { status, body } = await upload(s.base);
      // Không mode nào được trả 503 NOT_CONFIGURED dù apiKey rỗng.
      assert.notEqual(status, 503, `mode ${mode} không được đòi OPENAI_API_KEY`);
      assert.equal(body?.error?.code === "NOT_CONFIGURED", false);
      if (status === 200) {
        assert.equal(body.model, `sim-${mode}`);
        assert.equal(body.usage, null);
        assert.equal(body.retryCount, 0);
      }
      // /health: configured=false (thật sự không có key) NHƯNG ready=true, vì /recognize vẫn phục vụ
      // được. Nếu chỗ này báo ready=false thì PDA sẽ bật đèn OCR ĐỎ ở đúng cấu hình demo.
      const h = await (await fetch(`${s.base}/health`)).json();
      assert.equal(h.simMode, mode);
      assert.equal(h.configured, false, `mode ${mode}: không có OPENAI_API_KEY`);
      assert.equal(h.ready, true, `mode ${mode}: vẫn phục vụ được /recognize nên ready phải true`);
    } finally {
      await s.stop();
    }
  }
  assert.equal(fetchImpl.calls.length, 0, "không mode nào được gọi mạng");
});

test("OCR_SIM_MODE không hợp lệ → loadConfig ném lỗi nêu đủ 6 giá trị hợp lệ", () => {
  const saved = process.env.OCR_SIM_MODE;
  process.env.OCR_SIM_MODE = "banana";
  try {
    assert.throws(
      () => loadConfig({ dotenv: false }),
      (err) => {
        assert.match(err.message, /OCR_SIM_MODE/);
        for (const mode of OCR_SIM_MODES) assert.match(err.message, new RegExp(mode));
        return true;
      },
    );
    process.env.OCR_SIM_MODE = "garbage";
    assert.equal(loadConfig({ dotenv: false }).ocrSimMode, "garbage");
  } finally {
    if (saved === undefined) delete process.env.OCR_SIM_MODE;
    else process.env.OCR_SIM_MODE = saved;
  }
});
