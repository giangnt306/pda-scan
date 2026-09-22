import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpProvider, mapAiResponse } from "../src/recognition/providers/http.js";
import { createMockProvider } from "../src/recognition/providers/mock.js";

const image = { id: "img", mimeType: "image/jpeg", bytes: 3, getBuffer: async () => Buffer.from([1, 2, 3]), publicUrl: null };

test("mock provider: các mode success/slow/error", async () => {
  const p = createMockProvider({ delayMs: 0, slowDelayMs: 30 });
  const ok = await p.recognize({ recognitionId: "r", image, options: {} });
  assert.equal(ok.fields.partNumber.value, "BEX32181030AB");
  assert.ok(ok.raw.fields.length > 0);
  const t0 = Date.now();
  await p.recognize({ recognitionId: "r", image, options: { mode: "slow" } });
  assert.ok(Date.now() - t0 >= 25);
  await assert.rejects(p.recognize({ recognitionId: "r", image, options: { mode: "error" } }), /500/);
});

test("mock provider: mode timeout dừng khi signal abort", async () => {
  const p = createMockProvider({ delayMs: 0 });
  const signal = AbortSignal.timeout(20);
  await assert.rejects(p.recognize({ recognitionId: "r", image, options: { mode: "timeout" }, signal }));
});

test("http provider dùng cùng contract: gửi multipart, ánh xạ response", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ fields: [{ name: "partNumber", text: "BEX1", score: 0.5 }] }) };
  };
  const p = createHttpProvider({ url: "http://ai.local/recognize", apiKey: "k", fetchImpl });
  const r = await p.recognize({ recognitionId: "rid", image, signal: undefined });
  assert.equal(seen.url, "http://ai.local/recognize");
  assert.equal(seen.init.headers.authorization, "Bearer k");
  assert.ok(seen.init.body instanceof FormData);
  assert.equal(seen.init.body.get("recognitionId"), "rid");
  assert.deepEqual(r.fields, { partNumber: { value: "BEX1", confidence: 0.5 } });

  const bad = createHttpProvider({ url: "http://ai.local", fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error("html"); } }) });
  await assert.rejects(bad.recognize({ recognitionId: "r", image }), (e) => e.code === "PROVIDER_ERROR");
});

test("mapAiResponse ánh xạ snake_case của ai-server và bỏ trường null", () => {
  const m = mapAiResponse({ fields: [
    { name: "part_number", text: "BEX32181030AB", score: 0.94 },
    { name: "qty", text: "80", score: 0.9 },
    { name: "ship_date", text: null, score: 0 },
    { name: "gross_weight", text: "12,5", score: 0.7 },
  ] });
  assert.deepEqual(m, {
    partNumber: { value: "BEX32181030AB", confidence: 0.94 },
    quantity: { value: "80", confidence: 0.9 },
    grossWeight: { value: "12,5", confidence: 0.7 },
  });
});

test("http provider: AI server trả lỗi JSON → message kèm code của AI server; không kết nối được → PROVIDER_ERROR", async () => {
  const p = createHttpProvider({ url: "http://ai.local", fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: { code: "NOT_CONFIGURED", message: "Chưa đặt OPENAI_API_KEY" } }) }) });
  await assert.rejects(p.recognize({ recognitionId: "r", image }), (e) => e.code === "PROVIDER_ERROR" && /NOT_CONFIGURED.*OPENAI_API_KEY/.test(e.message));
  const down = createHttpProvider({ url: "http://127.0.0.1:1", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.recognize({ recognitionId: "r", image }), (e) => e.code === "PROVIDER_ERROR" && /Không kết nối/.test(e.message));
});

test("mapAiResponse chấp nhận dạng object và dạng list", () => {
  assert.deepEqual(mapAiResponse({ fields: { quantity: { value: "8", confidence: 0.9 }, note: "hi" } }), {
    quantity: { value: "8", confidence: 0.9 },
    note: { value: "hi", confidence: undefined },
  });
  assert.deepEqual(mapAiResponse(null), {});
});

test("http provider: gửi header x-request-id; upstream 504 → lỗi code UPSTREAM_TIMEOUT", async () => {
  let seen;
  const p = createHttpProvider({
    url: "http://ai.local/recognize",
    apiKey: "k",
    fetchImpl: async (url, init) => {
      seen = init;
      return { ok: true, status: 200, json: async () => ({ fields: [{ name: "part_number", text: "BEX1", score: 0.5 }] }) };
    },
  });
  await p.recognize({ recognitionId: "rid", image, requestId: "acc-e4-000001" });
  assert.equal(seen.headers["x-request-id"], "acc-e4-000001");
  assert.equal(seen.headers.authorization, "Bearer k");

  // Không gửi requestId thì không được bịa ra header rỗng.
  await p.recognize({ recognitionId: "rid", image });
  assert.equal("x-request-id" in seen.headers, false);

  // Upstream hết giờ: phải phân biệt với upstream hỏng, và KHÔNG retry (hết thời gian rồi).
  let calls = 0;
  const timedOut = createHttpProvider({
    url: "http://ai.local/recognize",
    maxAttempts: 2,
    backoffMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 504, json: async () => ({ error: { code: "UPSTREAM_TIMEOUT", message: "LLM quá lâu" } }) };
    },
  });
  await assert.rejects(timedOut.recognize({ recognitionId: "r", image }), (e) => e.code === "UPSTREAM_TIMEOUT");
  assert.equal(calls, 1, "504 không được retry");

  // Body báo UPSTREAM_TIMEOUT nhưng status khác 504 cũng phải map như vậy.
  const byBody = createHttpProvider({
    url: "http://ai.local/recognize",
    maxAttempts: 1,
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: { code: "UPSTREAM_TIMEOUT", message: "quá lâu" } }) }),
  });
  await assert.rejects(byBody.recognize({ recognitionId: "r", image }), (e) => e.code === "UPSTREAM_TIMEOUT");
});

test("http provider: 429 rồi 200 → retry 1 lần thành công; 400 → không retry", async () => {
  let calls = 0;
  const flaky = createHttpProvider({
    url: "http://ai.local/recognize",
    maxAttempts: 2,
    backoffMs: 5,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({ error: { code: "RATE_LIMITED", message: "chậm lại" } }) };
      return { ok: true, status: 200, json: async () => ({ fields: [{ name: "qty", text: "80", score: 0.9 }] }) };
    },
  });
  const r = await flaky.recognize({ recognitionId: "r", image });
  assert.equal(calls, 2);
  assert.deepEqual(r.fields, { quantity: { value: "80", confidence: 0.9 } });

  let badCalls = 0;
  const client = createHttpProvider({
    url: "http://ai.local/recognize",
    maxAttempts: 2,
    backoffMs: 5,
    fetchImpl: async () => {
      badCalls += 1;
      return { ok: false, status: 400, json: async () => ({ error: { code: "IMAGE_REQUIRED", message: "thiếu ảnh" } }) };
    },
  });
  await assert.rejects(client.recognize({ recognitionId: "r", image }), (e) => e.code === "PROVIDER_ERROR");
  assert.equal(badCalls, 1, "lỗi của chính ta thì retry vô nghĩa");

  // Hết ngân sách thời gian (< 2000 ms còn lại) thì cũng không retry dù lỗi thuộc loại retry được.
  let lateCalls = 0;
  const late = createHttpProvider({
    url: "http://ai.local/recognize",
    maxAttempts: 2,
    backoffMs: 5,
    fetchImpl: async () => {
      lateCalls += 1;
      return { ok: false, status: 503, json: async () => ({ error: { code: "BAD_RESPONSE", message: "hỏng" } }) };
    },
  });
  await assert.rejects(late.recognize({ recognitionId: "r", image, deadlineAt: Date.now() + 500 }), (e) => e.code === "PROVIDER_ERROR");
  assert.equal(lateCalls, 1);

  // 503 NOT_CONFIGURED: thiếu key thì thử lại bao nhiêu lần cũng vậy.
  let notConfigured = 0;
  const missingKey = createHttpProvider({
    url: "http://ai.local/recognize",
    maxAttempts: 2,
    backoffMs: 5,
    fetchImpl: async () => {
      notConfigured += 1;
      return { ok: false, status: 503, json: async () => ({ error: { code: "NOT_CONFIGURED", message: "Chưa đặt OPENAI_API_KEY" } }) };
    },
  });
  await assert.rejects(missingKey.recognize({ recognitionId: "r", image }), (e) => e.code === "PROVIDER_ERROR");
  assert.equal(notConfigured, 1);
});
