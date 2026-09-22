/* Client HTTP mỏng cho thiết bị ảo.
 *
 * Trách nhiệm: gắn đúng header, đặt timeout, đọc được cả body thành công lẫn body lỗi.
 * KHÔNG có trách nhiệm: thử lại. Thử lại là quyết định của thiết bị ảo (device.js) vì chỉ nó
 * biết requestId nghiệp vụ nào được dùng lại và bộ đếm nào phải tăng. Một lớp retry ẩn ở đây
 * sẽ làm counter.blocked / counter.netError mất hết ý nghĩa.
 *
 * Client KHÔNG BAO GIỜ ném vì lỗi mạng: nó trả { status: 0, networkError } để phía gọi quyết
 * định. Ném ở đây buộc mọi chỗ gọi phải try/catch và sẽ đẻ ra đúng thứ §8 cấm — try/catch
 * nuốt lỗi.
 */

import crypto from "node:crypto";
import { APP_VERSION } from "./args.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
/* Upload nhận dạng có thể phải xếp hàng sau 3 job chậm (semaphore 3 chạy + 10 chờ), nên nó
 * dùng trần riêng — đúng hồ sơ KINDS.recognize của FE (60 s). */
export const RECOGNIZE_TIMEOUT_MS = 60_000;

export function createClient({
  baseUrl,
  deviceId = null,
  sessionId = null,
  appVersion = APP_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  newRequestId = () => crypto.randomUUID(),
} = {}) {
  if (!baseUrl) throw new Error("createClient cần baseUrl");
  const root = String(baseUrl).replace(/\/+$/, "");
  const state = { deviceId, sessionId };

  async function request(method, path, { json = null, form = null, timeoutMs: perCall = null, headers = {} } = {}) {
    const url = `${root}${path}`;
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(perCall ?? timeoutMs) };

    /* x-request-id là dấu vết của MỘT LẦN GỬI: mỗi attempt một cái mới. Đừng nhầm với
     * body.requestId (khoá idempotency của phiếu) — nhầm hai thứ này làm check
     * requestId.unique không còn kiểm được gì. */
    init.headers["x-request-id"] = newRequestId();
    init.headers["x-app-version"] = appVersion;
    if (state.deviceId) init.headers["x-device-id"] = state.deviceId;
    if (state.sessionId) init.headers["x-session-id"] = state.sessionId;

    if (json !== null) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form !== null) {
      init.body = form; // fetch tự đặt content-type multipart kèm boundary
    }

    const startedAt = Date.now();
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      const aborted = err?.name === "TimeoutError" || err?.name === "AbortError";
      return {
        ok: false,
        status: 0,
        ms: Date.now() - startedAt,
        body: null,
        code: aborted ? "CLIENT_TIMEOUT" : "NETWORK_ERROR",
        message: err?.message ?? String(err),
        details: null,
        networkError: aborted ? `timeout sau ${perCall ?? timeoutMs} ms` : (err?.message ?? String(err)),
      };
    }

    const ms = Date.now() - startedAt;
    const raw = await res.text();
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { _raw: raw.slice(0, 500) };
      }
    }
    const error = body && typeof body === "object" ? body.error : null;
    return {
      ok: res.ok,
      status: res.status,
      ms,
      body,
      code: error?.code ?? null,
      message: error?.message ?? null,
      details: error?.details ?? null,
      networkError: null,
      retryAfterMs: error?.details?.retryAfterMs ?? null,
      headers: res.headers,
    };
  }

  return {
    get deviceId() {
      return state.deviceId;
    },
    get sessionId() {
      return state.sessionId;
    },
    setDeviceId(id) {
      state.deviceId = id;
    },
    setSessionId(id) {
      state.sessionId = id;
    },
    request,
    get: (path, opts) => request("GET", path, opts),
    post: (path, opts) => request("POST", path, opts),
    put: (path, opts) => request("PUT", path, opts),
    del: (path, opts) => request("DELETE", path, opts),
  };
}

/** Client không gắn thiết bị nào — dùng cho bộ chạy kịch bản khi đọc /api/status, /api/admin/*. */
export function createAdminClient(baseUrl, opts = {}) {
  return createClient({ baseUrl, deviceId: null, sessionId: null, ...opts });
}
