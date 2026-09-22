import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, normalizeModelOutput, recognizeWithLlm, buildMessages, FIELD_SPECS } from "../src/ocr.js";
import { loadConfig } from "../src/config.js";

const cfg = { apiKey: "k", baseUrl: "https://llm.local/v1", model: "gpt-4o-mini", imageDetail: "high" };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

test("extractJson: JSON thuần, bọc ```json```, và có chữ thừa", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Kết quả: {"a":1} xong'), { a: 1 });
  assert.throws(() => extractJson("không có json"), /không phải JSON/);
});

test("normalizeModelOutput: đủ mọi trường, null khi thiếu, score kẹp 0..1, chấp nhận dạng object", () => {
  const out = normalizeModelOutput({ fields: [{ name: "part_number", text: " BEX32181030AB ", score: 94 }, { name: "qty", text: null, score: 0.9 }, { name: "lạ", text: "x", score: 1 }], raw_text: "abc" }, "m");
  assert.equal(out.fields.length, FIELD_SPECS.length);
  const pn = out.fields.find((f) => f.name === "part_number");
  assert.deepEqual(pn, { name: "part_number", text: "BEX32181030AB", score: 0.94 });
  assert.deepEqual(out.fields.find((f) => f.name === "qty"), { name: "qty", text: null, score: 0 });
  assert.equal(out.rawText, "abc");
  const obj = normalizeModelOutput({ fields: { ship_date: { value: "15/9/2026", confidence: 0.6 }, supplier: "Made in Vietnam" } }, "m");
  assert.equal(obj.fields.find((f) => f.name === "ship_date").text, "15/9/2026");
  assert.equal(obj.fields.find((f) => f.name === "supplier").score, 0.5);
  // đơn vị / dấu chấm thay ô trống → null
  const blank = normalizeModelOutput({ fields: [{ name: "gross_weight", text: "KG", score: 0.9 }, { name: "ship_date", text: "..../2026", score: 0.9 }, { name: "qty", text: "15", score: 0.9 }, { name: "batch", text: "202608", score: 0.9 }] }, "m");
  assert.deepEqual(blank.fields.find((f) => f.name === "gross_weight"), { name: "gross_weight", text: null, score: 0 });
  assert.deepEqual(blank.fields.find((f) => f.name === "ship_date"), { name: "ship_date", text: null, score: 0 });
  assert.equal(blank.fields.find((f) => f.name === "qty").text, "15");
  assert.equal(blank.fields.find((f) => f.name === "batch").text, "202608");
});

test("finish_reason=length → TRUNCATED; JSON hỏng → BAD_RESPONSE kèm đoạn đầu để log", async () => {
  const cut = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"fields":[' } }] }) });
  await assert.rejects(recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: cfg, fetchImpl: cut }), (e) => e.code === "TRUNCATED");
  const junk = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "xin chào" } }] }) });
  await assert.rejects(recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: cfg, fetchImpl: junk }), (e) => e.code === "BAD_RESPONSE" && e.body === "xin chào");
});

test("buildMessages gửi ảnh dạng data URL kèm detail", () => {
  const m = buildMessages({ imageDataUrl: "data:image/jpeg;base64,AAA", detail: "low" });
  assert.equal(m[0].role, "system");
  assert.equal(m[1].content[1].image_url.detail, "low");
  assert.match(m[0].content, /part_number/);
});

test("recognizeWithLlm: gọi đúng endpoint, Bearer, json_schema; parse kết quả", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "gpt-4o-mini-2024", usage: { total_tokens: 10 }, choices: [{ message: { content: JSON.stringify({ fields: [{ name: "part_number", text: "BEX1", score: 0.9 }], raw_text: "x" }) } }] }) };
  };
  const r = await recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: cfg, fetchImpl });
  assert.equal(seen.url, "https://llm.local/v1/chat/completions");
  assert.equal(seen.init.headers.authorization, "Bearer k");
  assert.equal(seen.body.response_format.type, "json_schema");
  assert.match(seen.body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(r.model, "gpt-4o-mini-2024");
  assert.equal(r.fields.find((f) => f.name === "part_number").text, "BEX1");
  assert.equal(r.usage.total_tokens, 10);
});

test("recognizeWithLlm: 400 ở lần gọi json_schema → LÙI ĐỊNH DẠNG về json_object; 500 → UPSTREAM_ERROR; thiếu key → NOT_CONFIGURED", async () => {
  const formats = [];
  const fetchImpl = async (_u, init) => {
    const fmt = JSON.parse(init.body).response_format.type;
    formats.push(fmt);
    if (fmt === "json_schema") return { ok: false, status: 400, text: async () => "unsupported" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"fields":[],"raw_text":""}' } }] }) };
  };
  const r = await recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: cfg, fetchImpl });
  assert.deepEqual(formats, ["json_schema", "json_object"]);
  assert.equal(r.fields.every((f) => f.text === null), true);

  await assert.rejects(recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: cfg, fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }) }), (e) => e.code === "UPSTREAM_ERROR" && e.status === 500);
  await assert.rejects(recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: { ...cfg, apiKey: "" } }), (e) => e.code === "NOT_CONFIGURED");
});

/* ---- Phase 3: retry lỗi tạm + giảm output (chỉ THÊM, không sửa 6 test trên) ---- */

// backoff 5 ms cho test; ngân sách 20 s nên điều kiện "còn ≥ 2000 ms" luôn đúng.
const retryCfg = { ...cfg, upstreamMaxAttempts: 2, upstreamRetryBackoffMs: 5, upstreamTimeoutMs: 20000 };
const okPayload = JSON.stringify({ model: "gpt-4o-mini-2024-07-18", usage: { total_tokens: 12 }, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ fields: [{ name: "qty", text: "80", score: 0.9 }], raw_text: "QTY 80" }) } }] });

test("retry: LLM trả 429 rồi 200 → gọi 2 lần, kết quả đúng, retryCount = 1", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, text: async () => "rate limited" };
    return { ok: true, status: 200, text: async () => okPayload };
  };
  const warns = [];
  const r = await recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: retryCfg, fetchImpl, logger: { warn: (m, e) => warns.push([m, e]) }, requestId: "req-42" });
  assert.equal(calls, 2);
  assert.equal(r.retryCount, 1);
  assert.equal(r.model, "gpt-4o-mini-2024-07-18");
  assert.equal(r.fields.find((f) => f.name === "qty").text, "80");
  assert.deepEqual(warns[0][0], "ocr.retry");
  assert.equal(warns[0][1].requestId, "req-42");
  assert.equal(warns[0][1].waitedMs, 5);

  // Hết ngân sách (deadline đã qua) → KHÔNG retry dù 429 là lỗi tạm.
  calls = 0;
  await assert.rejects(
    recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: retryCfg, fetchImpl, deadlineAt: Date.now() + 100 }),
    (e) => e.code === "UPSTREAM_ERROR" && e.status === 429,
  );
  assert.equal(calls, 1);
});

test("retry: BAD_RESPONSE rồi 200 → retry 1 lần; HTTP 400 KHÔNG được retry lỗi tạm (chỉ lùi định dạng đúng 1 lần → tổng 2 lời gọi)", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "xin chào" } }] }) };
    return { ok: true, status: 200, text: async () => okPayload };
  };
  const r = await recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: retryCfg, fetchImpl: flaky });
  assert.equal(calls, 2);
  assert.equal(r.retryCount, 1);

  // 400 là lỗi của ta (ảnh hỏng) → KHÔNG retry lỗi tạm. Nhưng cơ chế lùi định dạng vẫn chạy
  // đúng một lần, nên tổng cộng có 2 lời gọi: json_schema rồi json_object, và không có lần thứ 3.
  const badFormats = [];
  const bad400 = async (_u, init) => {
    badFormats.push(JSON.parse(init.body).response_format.type);
    return { ok: false, status: 400, text: async () => '{"error":{"message":"Ảnh không hợp lệ"}}' };
  };
  await assert.rejects(
    recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: retryCfg, fetchImpl: bad400 }),
    (e) => e.code === "UPSTREAM_ERROR" && e.status === 400 && e.retryCount === 0,
  );
  assert.deepEqual(badFormats, ["json_schema", "json_object"], "400 → lùi định dạng 1 lần, KHÔNG retry");

  // NOT_CONFIGURED cũng không retry (không có gì để gọi) và không gọi mạng lần nào.
  await assert.rejects(recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: { ...retryCfg, apiKey: "" }, fetchImpl: bad400 }), (e) => e.code === "NOT_CONFIGURED");
  assert.equal(badFormats.length, 2);
});

test("max_tokens gửi lên đúng MAX_OUTPUT_TOKENS; rawText bị cắt còn tối đa 10 dòng", async () => {
  const twelveLines = Array.from({ length: 12 }, (_, i) => `DONG ${i + 1}`).join("\n");
  let seen;
  const fetchImpl = async (_u, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fields: [], raw_text: twelveLines }) } }] }) };
  };
  const r = await recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: { ...retryCfg, maxOutputTokens: 777 }, fetchImpl });
  assert.equal(seen.max_tokens, 777);
  assert.equal(r.rawText.split("\n").length, 10);
  assert.equal(r.rawText.split("\n").at(-1), "DONG 10");
  assert.match(seen.messages[0].content, /tối đa 10 dòng/);
});

/* ---- Lùi định dạng json_schema → json_object, và chuỗi timeout giảm dần (ĐÍNH CHÍNH R2) ---- */

// 5 kiểu body HTTP 400 thật của các nhà cung cấp khác nhau. Không kiểu nào được làm mất nhánh lùi.
const BODIES_400 = [
  ["vLLM", JSON.stringify({ object: "error", message: "guided_json is not enabled", type: "BadRequestError" })],
  ["Azure", JSON.stringify({ error: { code: "BadRequest", message: "Structured outputs are not available for this model." } })],
  ["body rỗng", ""],
  ["body không phải JSON", "<html><head><title>400 Bad Request</title></head></html>"],
  ["OpenAI (có từ khoá response_format)", JSON.stringify({ error: { message: "response_format is not supported" } })],
];

test("lùi định dạng: MỌI kiểu body HTTP 400 (vLLM, Azure, body rỗng, body không phải JSON, OpenAI) đều lùi json_schema → json_object và trả kết quả", async () => {
  for (const [label, body400] of BODIES_400) {
    const formats = [];
    const fetchImpl = async (_u, init) => {
      const fmt = JSON.parse(init.body).response_format.type;
      formats.push(fmt);
      if (fmt === "json_schema") return { ok: false, status: 400, text: async () => body400 };
      return { ok: true, status: 200, text: async () => okPayload };
    };
    const warns = [];
    const r = await recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: retryCfg, fetchImpl, logger: { warn: (m, e) => warns.push([m, e]) }, requestId: "req-400" });
    assert.deepEqual(formats, ["json_schema", "json_object"], `body 400 kiểu ${label} phải lùi được định dạng`);
    assert.equal(r.fields.find((f) => f.name === "qty").text, "80", label);
    // Lùi định dạng KHÔNG phải retry lỗi tạm → retryCount vẫn 0.
    assert.equal(r.retryCount, 0, label);
    assert.deepEqual(warns.map((w) => w[0]), ["ocr.format_fallback"], label);
    assert.equal(warns[0][1].requestId, "req-400", label);
  }
});

test("lùi định dạng chỉ xảy ra ĐÚNG MỘT LẦN: json_object cũng trả 400 → ném UPSTREAM_ERROR 400 sau đúng 2 lời gọi, không lặp vô hạn", async () => {
  const formats = [];
  const always400 = async (_u, init) => {
    formats.push(JSON.parse(init.body).response_format.type);
    return { ok: false, status: 400, text: async () => "" };
  };
  await assert.rejects(
    recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: retryCfg, fetchImpl: always400 }),
    (e) => e.code === "UPSTREAM_ERROR" && e.status === 400 && e.retryCount === 0,
  );
  assert.deepEqual(formats, ["json_schema", "json_object"]);
});

test("hai cơ chế tách bạch: lùi định dạng (400) rồi retry lỗi tạm (429) → 3 lời gọi, attempt 2 đi thẳng json_object, retryCount = 1", async () => {
  const formats = [];
  let n = 0;
  const fetchImpl = async (_u, init) => {
    formats.push(JSON.parse(init.body).response_format.type);
    n += 1;
    if (n === 1) return { ok: false, status: 400, text: async () => "guided_json is not enabled" };
    if (n === 2) return { ok: false, status: 429, text: async () => "rate limited" };
    return { ok: true, status: 200, text: async () => okPayload };
  };
  const r = await recognizeWithLlm({ imageBuffer: jpeg, mimeType: "image/jpeg", config: retryCfg, fetchImpl });
  assert.deepEqual(formats, ["json_schema", "json_object", "json_object"]);
  assert.equal(r.retryCount, 1, "chỉ lần 429 mới tính là retry");
  assert.equal(r.fields.find((f) => f.name === "qty").text, "80");
});

test("mặc định config: UPSTREAM_TIMEOUT_MS = 18000 — chuỗi timeout giảm dần webapp 60000 > BE 20000 > ai-server 18000 (ĐÍNH CHÍNH R2)", () => {
  const def = loadConfig({ dotenv: false });
  assert.equal(def.upstreamTimeoutMs, 18000);
  // Hằng số hợp đồng của hai tầng ngoài (01-contracts.md §13.2 + ĐÍNH CHÍNH R2).
  const WEBAPP_TIMEOUT_MS = 60000;
  const BE_RECOGNITION_TIMEOUT_MS = 20000;
  assert.equal(WEBAPP_TIMEOUT_MS > BE_RECOGNITION_TIMEOUT_MS, true, "webapp phải chờ lâu hơn BE");
  assert.equal(BE_RECOGNITION_TIMEOUT_MS > def.upstreamTimeoutMs, true, "ai-server phải hết hạn TRƯỚC BE");
  assert.equal(BE_RECOGNITION_TIMEOUT_MS - def.upstreamTimeoutMs >= 2000, true, "cần đệm ≥ 2000 ms để ai-server kịp trả 504 UPSTREAM_TIMEOUT");
  // Các mặc định còn lại của Phase 3 (trước đây nằm lẫn trong test max_tokens).
  assert.equal(def.maxOutputTokens, 900);
  assert.equal(def.upstreamMaxAttempts, 2);
  assert.equal(def.upstreamRetryBackoffMs, 500);
  assert.equal(def.ocrSimMode, "passthrough");
  assert.equal(def.ocrSimDelayMs, 25000);
  // Người vận hành vẫn đặt đè được bằng env.
  const saved = process.env.UPSTREAM_TIMEOUT_MS;
  process.env.UPSTREAM_TIMEOUT_MS = "9000";
  try {
    assert.equal(loadConfig({ dotenv: false }).upstreamTimeoutMs, 9000);
  } finally {
    if (saved === undefined) delete process.env.UPSTREAM_TIMEOUT_MS;
    else process.env.UPSTREAM_TIMEOUT_MS = saved;
  }
});
