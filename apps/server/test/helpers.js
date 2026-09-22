import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { logger } from "../src/log.js";

/* JPEG 1x1 hợp lệ (134 byte) và PNG 1x1 hợp lệ. */
export const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pda-scan-test-"));
}

/* deviceId/sessionId hợp lệ cho test (UUID v4 chữ thường). */
export const DEVICE_A = "0d5c7f33-9d59-4d2e-8f11-0b3c9c0bd511";
export const DEVICE_B = "1c9e00a7-6b21-4d8f-8a3c-7d0e5f2a4b16";

/* Logger thu lại mọi dòng log để test khẳng định được BE có cảnh báo đúng chỗ hay không. */
export function recordingLogger() {
  const lines = [];
  const push = (level) => (msg, extra) => lines.push({ level, msg, ...extra });
  return { lines, info: push("info"), warn: push("warn"), error: push("error"), find: (msg) => lines.filter((l) => l.msg === msg) };
}

/* Khởi động app trên port ngẫu nhiên với dataDir riêng.
 *
 * Mặc định Phase 4 CỐ Ý ngược với production (O1): test chạy trên nền "Phase 3" — không adapter
 * SAP, không worker nền, không rule nghiệp vụ — nên 95 test cũ không phải sửa một ký tự. Test
 * Phase 4 tự bật bằng startSapApp()/startRulesApp() hoặc overrides. */
export async function startTestApp(
  overrides = {},
  { dataDir = tempDataDir(), provider, probeFetch, sapAdapter, logger: appLogger } = {},
) {
  const config = loadConfig({
    dotenv: false,
    dataDir,
    dbPath: path.join(dataDir, "test.sqlite"),
    uploadsDir: path.join(dataDir, "uploads"),
    mock: { delayMs: 0, slowDelayMs: 200, mode: "success" },
    recognitionTimeoutMs: 2000,
    simOverride: true,
    sap: { adapter: "none" },
    outbox: { enabled: false, tickMs: 20 },
    rules: { duplicate: false, location: false },
    ...overrides,
  });
  const app = buildApp(config, { logger: appLogger ?? logger.silent, provider, probeFetch, sapAdapter });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    config,
    dataDir,
    base,
    async stop() {
      await new Promise((r) => app.server.close(r));
      /* app.close() là ASYNC từ Phase 5: nó chờ job nhận dạng nền xong TRƯỚC khi db.close().
       * Thiếu `await` ở đây thì một job nền sẽ prepare() trên DB đã đóng và ném ERR_SQLITE ra
       * ngoài mọi try/catch, làm đỏ những test chẳng liên quan gì. */
      await app.close();
    },
    cleanup() {
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** App có SAP mock + worker chạy nhanh. */
export async function startSapApp(overrides = {}, opts = {}) {
  return startTestApp({ sap: { adapter: "mock" }, outbox: { enabled: true, tickMs: 20 }, ...overrides }, opts);
}

/** App có bật 2 rule nghiệp vụ. */
export async function startRulesApp(overrides = {}, opts = {}) {
  return startTestApp({ rules: { duplicate: true, location: true }, ...overrides }, opts);
}

/* Chờ tới khi điều kiện đúng, tránh sleep cứng: worker chạy theo tick nên thời điểm chính xác
 * không đoán được, nhưng KẾT QUẢ thì tất định. Hết giờ mà chưa đúng → ném, test đỏ. */
export async function waitFor(fn, { timeoutMs = 5000, stepMs = 10, label = "điều kiện" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`waitFor quá ${timeoutMs} ms mà ${label} vẫn chưa đúng`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/* signal thêm ở CUỐI và có mặc định: chữ ký cũ của mọi test đang dùng upload() không đổi. */
export async function upload(base, buffer, { query = "", filename = "label.jpg", type = "image/jpeg", field = "image", headers = {}, signal } = {}) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), filename);
  const res = await fetch(`${base}/api/recognitions${query}`, { method: "POST", body: form, headers, ...(signal ? { signal } : {}) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

/* Tham số headers thêm vào CUỐI và có mặc định: chữ ký cũ của 35 test Phase 1 không đổi. */
async function sendJson(base, pathName, method, body, headers) {
  const res = await fetch(`${base}${pathName}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export const postJson = (base, pathName, body, headers = {}) => sendJson(base, pathName, "POST", body, headers);
export const putJson = (base, pathName, body, headers = {}) => sendJson(base, pathName, "PUT", body, headers);
export const delJson = (base, pathName, headers = {}) => sendJson(base, pathName, "DELETE", undefined, headers);

export async function getJson(base, pathName, headers = {}) {
  const res = await fetch(`${base}${pathName}`, { headers });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export const validData = () => ({
  partNumber: "BEX32181030AB",
  partName: "BATTERY_PACK_REAR_FENDER",
  quantity: "80",
  shipmentDate: "2026-09-15",
  supplier: "Nội bộ — Made in Vietnam",
  location: "A-03-02",
});

export const receiptBody = (requestId, extra = {}) => ({
  requestId,
  recognitionId: null,
  source: "manual",
  data: validData(),
  fieldMeta: {},
  ...extra,
});
