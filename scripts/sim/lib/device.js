/* Vòng đời MỘT thiết bị ảo (05-virtual-devices.md §2.1).
 *
 * Thiết bị ảo không biết gì về file kịch bản JSON: nó chỉ biết đăng ký, mở phiên, lặp
 * (heartbeat + nhận dạng + lưu phiếu) và kết phiên. Đội thiết bị (fleet.js) mới là nơi điều
 * phối, và bộ chạy kịch bản mới là nơi chấm điểm.
 *
 * HAI THỨ DỄ NHẦM NHẤT, ghi ở đây để lần sau đọc lại không sai:
 *   · body.requestId  — sinh MỘT LẦN cho mỗi phiếu, thử lại dùng lại y nguyên (khoá idempotency)
 *   · x-request-id    — mỗi attempt một cái mới (client.js tự lo), chỉ để truy vết log
 *
 * Thiết bị ảo KHÔNG mô phỏng hàng chờ ngoại tuyến. Đó là việc của webapp và đã có test riêng;
 * trộn vào đây sẽ làm check requestId.unique mất ý nghĩa.
 */

import crypto from "node:crypto";
import { createClient, RECOGNIZE_TIMEOUT_MS } from "./client.js";
import { createRng } from "./rng.js";
import { makeReceiptData, imageForm } from "./fixtures.js";

export const BLOCKED_RETRY_DELAY_MS = 2000;
export const BLOCKED_MAX_RETRIES = 30;
export const BUSY_MAX_RETRIES = 2;
export const POLL_INTERVAL_MS = 1000;
export const POLL_BUDGET_MS = 60_000;

const SIM_BLOCK_CODES = new Set(["BACKEND_DOWN_SIMULATED", "BACKEND_READONLY"]);
const RECOGNITION_FAIL_CODES = new Set([
  "RECOGNITION_TIMEOUT",
  "RECOGNITION_FAILED",
  "PROVIDER_NOT_CONFIGURED",
  "INTERRUPTED",
  "CLIENT_ABORTED",
  "RECOGNITION_NOT_FOUND",
]);

/** Sleep huỷ được: stop() không phải chờ hết một nhịp 10 s mới kết thúc. */
function cancellableSleep(ms, token) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      token.timers.delete(timer);
      resolve();
    }, ms);
    token.timers.add(timer);
    token.wakers.add(() => {
      clearTimeout(timer);
      token.timers.delete(timer);
      resolve();
    });
  });
}

export function createDevice({
  index,
  options,
  image,
  location,
  stats,
  log,
  now = () => Date.now(),
  /* Chu kỳ chờ giữa hai lần thử lại khi bị chặn / lỗi mạng. Tham số hoá để test kiểm được
   * đúng hành vi thử lại mà không phải chờ 2 giây mỗi vòng; mặc định là giá trị thật. */
  retryDelayMs = BLOCKED_RETRY_DELAY_MS,
}) {
  const ordinal = String(index + 1).padStart(2, "0");
  const deviceId = crypto.randomUUID();
  const name = `${options.prefix}-${ordinal}`;
  /* Mỗi thiết bị một nhánh PRNG riêng, phái sinh từ --seed: cùng seed → cùng dữ liệu, nhưng
   * hai thiết bị trong cùng lần chạy không sinh ra nhãn giống hệt nhau (trừ --same-label). */
  const rng = createRng(options.seed * 1_000_003 + index);
  const client = createClient({ baseUrl: options.base, deviceId });

  const token = { stopped: false, timers: new Set(), wakers: new Set() };
  const state = { sessionId: null, registered: false, battery: 1, heartbeatTimer: null, receipts: 0 };

  const sleep = (ms) => cancellableSleep(ms, token);
  const say = (text) => log?.(`${name} ${text}`);

  /* Phân loại MỘT kết quả HTTP về đúng bộ đếm của §2.3. Trả hành động tiếp theo cho vòng lặp
   * gọi nó — không tự thử lại ở đây, vì mỗi lời gọi có chính sách thử lại khác nhau. */
  function classify(res) {
    if (res.status === 0) return { kind: "netError" };
    if (res.ok) return { kind: "ok" };
    if (res.status === 429) return { kind: "busy", retryAfterMs: res.retryAfterMs ?? 3000 };
    if (res.status === 503 && SIM_BLOCK_CODES.has(res.code)) return { kind: "blocked" };
    if (res.status === 503 && res.code === "SAVE_FAILED_SIMULATED") return { kind: "saveFailed" };
    if (res.status === 409 && res.code === "DUPLICATE_LABEL") return { kind: "duplicate" };
    if (res.status === 422 && res.code === "LOCATION_UNKNOWN") return { kind: "invalidLocation" };
    if (res.status === 422) return { kind: "invalid" };
    if (RECOGNITION_FAIL_CODES.has(res.code)) return { kind: "recognizeFailed", code: res.code };
    return { kind: "other", code: res.code ?? `HTTP_${res.status}` };
  }

  async function register() {
    for (let attempt = 0; attempt <= BLOCKED_MAX_RETRIES && !token.stopped; attempt += 1) {
      const res = await client.post("/api/devices/register", {
        json: { deviceId, name, appVersion: "sim-0.5.0", platform: "virtual-device", network: "wifi" },
      });
      const c = classify(res);
      if (c.kind === "ok") {
        state.registered = true;
        return true;
      }
      if (c.kind === "blocked") stats.bump("blocked");
      else if (c.kind === "netError") stats.bump("netError");
      else {
        stats.bump("otherError");
        stats.problem(`${name} đăng ký hỏng: ${res.status} ${res.code ?? res.networkError ?? ""}`.trim());
        return false;
      }
      await sleep(retryDelayMs);
    }
    return false;
  }

  async function startSession() {
    if (options.noSession) return true;
    for (let attempt = 0; attempt <= BLOCKED_MAX_RETRIES && !token.stopped; attempt += 1) {
      const res = await client.post("/api/sessions/start", {
        json: { operator: `Ảo ${ordinal}`, warehouse: options.warehouse, shift: options.shift },
      });
      const c = classify(res);
      if (c.kind === "ok") {
        state.sessionId = res.body?.session?.id ?? null;
        client.setSessionId(state.sessionId);
        return true;
      }
      if (c.kind === "blocked") stats.bump("blocked");
      else if (c.kind === "netError") stats.bump("netError");
      else {
        stats.bump("otherError");
        stats.problem(`${name} mở phiên hỏng: ${res.status} ${res.code ?? res.networkError ?? ""}`.trim());
        return false;
      }
      await sleep(retryDelayMs);
    }
    return false;
  }

  async function endSession() {
    if (!state.sessionId) return;
    const id = state.sessionId;
    state.sessionId = null;
    /* Kết phiên là việc DỌN DẸP: thử tối đa 3 lần rồi thôi. Vòng thử lại KHÔNG giới hạn ở đây
     * sẽ treo quá trình thoát khi máy chủ đang down — đúng lúc ta cần thoát nhanh nhất. */
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await client.post(`/api/sessions/${id}/end`, { json: { reason: "manual" }, timeoutMs: 5000 });
      if (last.ok) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!last?.ok) stats.note(`${name} không kết được phiên (${last?.status} ${last?.code ?? last?.networkError ?? ""})`);
    client.setSessionId(null);
  }

  async function heartbeat() {
    if (!state.registered || token.stopped) return;
    state.battery = Math.max(0.05, Number((state.battery - 0.01).toFixed(4)));
    const res = await client.post(`/api/devices/${deviceId}/heartbeat`, {
      json: { appVersion: "sim-0.5.0", network: "wifi", battery: state.battery, pendingQueue: 0 },
      timeoutMs: 10_000,
    });
    if (res.ok) stats.bump("heartbeats");
  }

  /* --- Nhận dạng: phải xử lý ĐƯỢC CẢ 201 (sync) LẪN 202 (async) ------------------------- */

  async function pollRecognition(recognitionId, startedAt) {
    const deadline = startedAt + POLL_BUDGET_MS;
    while (!token.stopped && now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (token.stopped) break;
      stats.bump("recognizePolls");
      const res = await client.get(`/api/recognitions/${recognitionId}`, { timeoutMs: 8000 });
      if (res.status === 0) continue; // lỗi mạng khi poll: bỏ nhịp này, KHÔNG bỏ cả vòng poll
      if (res.status === 404) {
        stats.bump("recognizeFailed");
        return null;
      }
      if (!res.ok) {
        stats.bump("otherError");
        stats.problem(`${name} poll nhận dạng lỗi lạ: ${res.status} ${res.code ?? ""}`.trim());
        return null;
      }
      const status = res.body?.status;
      if (status === "pending") continue;
      if (status === "completed") {
        stats.recognizeMs(now() - startedAt);
        stats.bump("recognizeOk");
        return { recognitionId, fields: res.body?.fields ?? null };
      }
      // status "failed" trả HTTP 200: đó là KẾT QUẢ, không phải lỗi mạng.
      stats.bump("recognizeFailed");
      stats.note(`${name} nhận dạng thất bại: ${res.body?.error?.code ?? "?"}`);
      return null;
    }
    stats.bump("recognizeFailed");
    /* Hai lý do ra khỏi vòng thăm dò, và chúng KHÁC nhau với người đọc báo cáo: hết ngân sách
     * thăm dò (máy chủ thật sự không trả lời kịp) hay thiết bị bị dừng giữa chừng lúc kịch bản
     * kết thúc. Ghi chung một câu "quá 60000 ms" cho cả hai là nói sai về trường hợp thứ hai. */
    stats.note(
      token.stopped
        ? `${name} bị dừng khi đang thăm dò nhận dạng (chưa có kết quả dứt khoát)`
        : `${name} nhận dạng quá ${POLL_BUDGET_MS} ms chưa xong`,
    );
    return null;
  }

  /** Trả { recognitionId, fields } khi đọc được nhãn, null khi không. Không bao giờ ném. */
  async function recognize() {
    let busyLeft = BUSY_MAX_RETRIES;
    let blockedLeft = BLOCKED_MAX_RETRIES;
    while (!token.stopped) {
      const startedAt = now();
      const res = await client.post("/api/recognitions", {
        form: imageForm(image),
        timeoutMs: RECOGNIZE_TIMEOUT_MS,
      });
      const c = classify(res);

      if (c.kind === "ok" && res.status === 202) {
        /* Đếm NGAY tại đây, trước mọi kiểm tra body: 202 đã về nghĩa là máy chủ thật sự đi
         * đường bất đồng bộ. Đó là bằng chứng mà kịch bản async cần. */
        stats.bump("recognizeAccepted202");
        const id = res.body?.recognitionId;
        if (!id) {
          stats.bump("otherError");
          stats.problem(`${name} nhận 202 nhưng thiếu recognitionId`);
          return null;
        }
        const first = res.body?.pollAfterMs;
        await sleep(Number.isInteger(first) && first > 0 ? Math.min(first, POLL_INTERVAL_MS) : 0);
        return await pollRecognition(id, startedAt);
      }
      if (c.kind === "ok") {
        stats.recognizeMs(now() - startedAt);
        stats.bump("recognizeOk");
        return { recognitionId: res.body?.recognitionId ?? null, fields: res.body?.fields ?? null };
      }
      if (c.kind === "busy") {
        stats.bump("busy429");
        if (busyLeft-- <= 0) return null;
        await sleep(c.retryAfterMs);
        continue;
      }
      if (c.kind === "blocked") {
        stats.bump("blocked");
        if (blockedLeft-- <= 0) return null;
        await sleep(retryDelayMs);
        continue;
      }
      if (c.kind === "netError") {
        stats.bump("netError");
        if (blockedLeft-- <= 0) return null;
        await sleep(retryDelayMs);
        continue;
      }
      if (c.kind === "recognizeFailed") {
        stats.bump("recognizeFailed");
        stats.note(`${name} nhận dạng thất bại: ${c.code}`);
        return null;
      }
      stats.bump("otherError");
      stats.problem(`${name} upload ảnh lỗi lạ: ${res.status} ${res.code ?? res.networkError ?? ""}`.trim());
      return null;
    }
    return null;
  }

  /* --- Lưu phiếu ----------------------------------------------------------------------- */

  async function saveReceipt({ recognitionId = null } = {}) {
    const wantInvalid = options.failRate > 0 && rng.next() * 100 < options.failRate;
    const data = makeReceiptData({ rng, location, sameLabel: options.sameLabel, invalid: wantInvalid });

    /* MỘT requestId cho MỘT phiếu. Mọi lần thử lại dưới đây dùng lại đúng chuỗi này — đó là
     * cơ chế idempotency của BE và cũng chính là thứ check requestId.unique đang bảo vệ. */
    let requestId = crypto.randomUUID();
    stats.requestId(requestId);
    let allowDuplicate = false;
    let blockedLeft = BLOCKED_MAX_RETRIES;
    let duplicateLeft = 1;

    while (!token.stopped) {
      const body = { requestId, source: recognitionId ? "camera" : "manual", data, fieldMeta: {} };
      if (recognitionId) body.recognitionId = recognitionId;
      if (allowDuplicate) body.allowDuplicate = true;

      const res = await client.post("/api/receipts", { json: body });
      const c = classify(res);

      if (c.kind === "ok") {
        stats.saveMs(res.ms);
        stats.bump("saved");
        stats.savedAt(now());
        if (res.status === 200 || res.body?.idempotent === true) stats.bump("idempotent");
        state.receipts += 1;
        return true;
      }
      if (c.kind === "duplicate") {
        stats.bump("duplicate");
        if (duplicateLeft-- <= 0) return false;
        /* Gửi lại NGAY với requestId MỚI (05- §2.3): dùng lại requestId cũ sẽ rơi vào nhánh
         * idempotency và trả về chính phiếu chưa được tạo. Đây là ngoại lệ DUY NHẤT của luật
         * "thử lại dùng lại requestId cũ". */
        requestId = crypto.randomUUID();
        stats.requestId(requestId);
        allowDuplicate = true;
        continue;
      }
      if (c.kind === "invalid") {
        stats.bump("invalid");
        return false;
      }
      if (c.kind === "invalidLocation") {
        stats.bump("invalidLocation");
        stats.note(`${name} vị trí "${location}" không có trong danh mục kho`);
        return false;
      }
      if (c.kind === "saveFailed") {
        stats.bump("saveFailed");
        return false;
      }
      if (c.kind === "busy") {
        stats.bump("busy429");
        await sleep(c.retryAfterMs);
        continue;
      }
      if (c.kind === "blocked") {
        stats.bump("blocked");
        if (blockedLeft-- <= 0) return false;
        await sleep(retryDelayMs);
        continue;
      }
      if (c.kind === "netError") {
        stats.bump("netError");
        if (blockedLeft-- <= 0) return false;
        await sleep(retryDelayMs);
        continue;
      }
      stats.bump("otherError");
      stats.problem(`${name} lưu phiếu lỗi lạ: ${res.status} ${res.code ?? res.networkError ?? ""}`.trim());
      return false;
    }
    return false;
  }

  async function cycle() {
    let recognitionId = null;
    if (options.recognize || options.recognizeOnly) {
      const out = await recognize();
      recognitionId = out?.recognitionId ?? null;
    }
    /* PDA thật gặp lỗi nhận dạng vẫn lưu phiếu bằng dữ liệu nhập tay — đó là lối thoát mà cả
     * Phase 3 lẫn Phase 4 bắt buộc phải có, nên thiết bị ảo cũng phải làm đúng thế. */
    if (options.recognizeOnly) return;
    await saveReceipt({ recognitionId });
  }

  async function loop() {
    if (options.rate <= 0) return; // chỉ heartbeat
    const intervalMs = 60_000 / options.rate;
    let nextDue = now();
    while (!token.stopped) {
      await cycle();
      if (token.stopped) break;
      nextDue += intervalMs;
      /* Một chu kỳ chạy lâu hơn nhịp (OCR chậm 25 s với rate 6) thì BỎ NHỊP, không dồn:
       * PDA thật cũng không bắn bù 3 phiếu liền khi vừa thoát khỏi một lần chờ dài. */
      if (nextDue < now()) nextDue = now();
      await sleep(nextDue - now());
    }
  }

  return {
    deviceId,
    name,
    get sessionId() {
      return state.sessionId;
    },
    get receipts() {
      return state.receipts;
    },
    recognizeOnce: recognize,
    /* Lưu đúng MỘT phiếu rồi trả về. Dùng cho test hành vi §2.3 mà không phải chạy cả vòng đời. */
    saveOnce: saveReceipt,

    async run({ startDelayMs = 0 } = {}) {
      await sleep(startDelayMs);
      if (token.stopped) return;
      if (!(await register())) return;
      say("đã đăng ký");
      if (!(await startSession())) return;
      state.heartbeatTimer = setInterval(() => {
        heartbeat().catch((err) => stats.problem(`${name} heartbeat ném: ${err?.message}`));
      }, options.heartbeat);
      await heartbeat();
      await loop();
    },

    /* Dừng: đánh thức mọi sleep đang chờ, tắt heartbeat, kết phiên. Gọi được nhiều lần. */
    async stop() {
      token.stopped = true;
      for (const wake of token.wakers) wake();
      token.wakers.clear();
      if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
      }
      await endSession();
    },
  };
}
