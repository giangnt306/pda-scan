import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, upload, JPEG, postJson, receiptBody } from "./helpers.js";

test("giới hạn kích thước upload → 413", async () => {
  const t = await startTestApp({ maxUploadBytes: 100 });
  try {
    const { status, body } = await upload(t.base, JPEG); // 134 byte > 100
    assert.equal(status, 413);
    assert.equal(body.error.code, "IMAGE_TOO_LARGE");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("upload chunked (không khai content-length) vượt giới hạn cứng → 413 PAYLOAD_TOO_LARGE chứ không phải mất kết nối", async () => {
  const t = await startTestApp({ maxUploadBytes: 100 });
  try {
    // Body dạng stream → không có content-length, server phải tự cắt khi đọc quá giới hạn.
    const huge = Buffer.alloc(200_000, 0x41);
    const res = await fetch(`${t.base}/api/recognitions`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(huge);
          c.close();
        },
      }),
      duplex: "half",
    });
    assert.equal(res.status, 413, "PDA phải đọc được mã lỗi, không bị reset kết nối");
    assert.equal((await res.json()).error.code, "PAYLOAD_TOO_LARGE");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("MOCK_MODE=timeout + RECOGNITION_TIMEOUT_MS ngắn → 504 RECOGNITION_TIMEOUT", async () => {
  const t = await startTestApp({ recognitionTimeoutMs: 50, mock: { mode: "timeout", delayMs: 0, slowDelayMs: 0 } });
  try {
    const { status, body } = await upload(t.base, JPEG);
    assert.equal(status, 504);
    assert.equal(body.error.code, "RECOGNITION_TIMEOUT");
    assert.ok(body.error.details.recognitionId);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("SIM_OVERRIDE=false → query ?sim bị bỏ qua, ?simSave bị bỏ qua", async () => {
  const t = await startTestApp({ simOverride: false });
  try {
    assert.equal((await upload(t.base, JPEG, { query: "?sim=error" })).status, 201);
    assert.equal((await postJson(t.base, "/api/receipts?simSave=fail", receiptBody("req-nooverride-01"))).status, 201);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("SIM_SAVE_FAIL=true → mọi lần lưu đều 503", async () => {
  const t = await startTestApp({ simSaveFail: true });
  try {
    assert.equal((await postJson(t.base, "/api/receipts", receiptBody("req-savefail-all1"))).status, 503);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("RECOGNITION_PROVIDER=http chưa cấu hình URL → 503 PROVIDER_NOT_CONFIGURED", async () => {
  const t = await startTestApp({ provider: "http", ai: { url: "" } });
  try {
    const { status, body } = await upload(t.base, JPEG);
    assert.equal(status, 503);
    assert.equal(body.error.code, "PROVIDER_NOT_CONFIGURED");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("CORS: tắt mặc định; bật bằng corsOrigins → preflight 204 và header cho origin hợp lệ", async () => {
  const off = await startTestApp();
  try {
    const r = await fetch(`${off.base}/api/health`, { headers: { origin: "http://localhost:5174" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(`${off.base}/api/health`, { method: "OPTIONS", headers: { origin: "http://localhost:5174" } })).status, 403);
  } finally {
    await off.stop();
    off.cleanup();
  }
  const on = await startTestApp({ corsOrigins: ["http://localhost:5174", "https://fe.local"] });
  try {
    const pre = await fetch(`${on.base}/api/receipts`, { method: "OPTIONS", headers: { origin: "http://localhost:5174", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:5174");
    assert.match(pre.headers.get("access-control-allow-headers"), /content-type/);
    const ok = await fetch(`${on.base}/api/health`, { headers: { origin: "https://fe.local" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://fe.local");
    const bad = await fetch(`${on.base}/api/health`, { headers: { origin: "https://evil.local" } });
    assert.equal(bad.status, 200); // vẫn phục vụ, nhưng không có header CORS → browser chặn
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  } finally {
    await on.stop();
    on.cleanup();
  }
});
