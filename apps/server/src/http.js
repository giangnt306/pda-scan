import http from "node:http";
import crypto from "node:crypto";
import { OCR_MODES, SAVE_MODES } from "./config.js";
import { RecognitionError, RecognitionBusyError, CAPTURE_REF_MAX } from "./recognition/service.js";
import { ReceiptError } from "./receipts.js";
import { isDeviceId, isUuidV4, NETWORKS, HEARTBEAT_INTERVAL_MS, clampBattery } from "./devices.js";
import { SHIFTS, END_REASONS } from "./sessions.js";
import { validateScenarioPatch, SIM_DEFAULT } from "./sim/engine.js";
import { decideSim } from "./sim/middleware.js";
import { RECEIPT_STATUSES } from "./lifecycle.js";
import { CLIENT_EVENT_TYPES } from "./events.js";
import { extraRoutes } from "./routes/index.js";

const JSON_LIMIT = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SIM_DISABLED_MSG = "Mô phỏng đang tắt (SIM_OVERRIDE=false)";
/* Trần một lô sự kiện PDA gửi lên (§4.5). Rỗng hoặc vượt trần đều là 400 INVALID_BODY. */
const MAX_DEVICE_EVENTS = 20;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendError(res, status, code, message, details, headers) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } }, headers);
}

/* FE nào cũng phải gắn x-request-id, nhưng BE không được từ chối request vì thiếu nó:
 * truy vết là việc của server, không phải điều kiện để phục vụ (§2.2). */
export function normalizeRequestId(raw) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v === "string" && REQUEST_ID.test(v)) return v;
  return crypto.randomUUID();
}

const header = (req, name) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Đọc toàn bộ body, cắt sớm khi vượt giới hạn. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      return reject(new ApiError(413, "PAYLOAD_TOO_LARGE", `Body vượt giới hạn ${limit} byte`));
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        /* Ngừng đọc chứ KHÔNG destroy: destroy giết socket trước khi kịp trả lời, PDA chỉ
         * thấy "mất kết nối" thay vì 413 đọc được. Node tự đóng kết nối sau khi response
         * được gửi vì body chưa đọc hết. */
        req.pause();
        return reject(new ApiError(413, "PAYLOAD_TOO_LARGE", `Body vượt giới hạn ${limit} byte`));
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const ct = req.headers["content-type"] || "";
  if (!ct.startsWith("application/json")) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Cần Content-Type application/json");
  const buf = await readBody(req, JSON_LIMIT);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Body không phải JSON hợp lệ");
  }
}

/* Dùng parser multipart có sẵn của runtime (fetch API) — không thêm dependency. */
async function readMultipart(req, limit) {
  const ct = req.headers["content-type"] || "";
  if (!ct.startsWith("multipart/form-data")) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Cần multipart/form-data với field 'image'");
  const buf = await readBody(req, limit + 64 * 1024);
  try {
    return await new Request("http://local/upload", { method: "POST", headers: { "content-type": ct }, body: buf }).formData();
  } catch {
    throw new ApiError(400, "INVALID_MULTIPART", "Không đọc được multipart body");
  }
}

/* ?sim= / ?simSave= là kịch bản chỉ áp cho đúng request đó, ưu tiên trên cả kịch bản đã lưu.
 * Giữ mã lỗi cũ INVALID_SIM (không phải INVALID_SIM_CONFIG) cho tương thích ngược. */
export function simOption(url, config) {
  if (!config.simOverride) return null;
  const patch = {};
  const sim = url.searchParams.get("sim");
  if (sim) {
    if (!OCR_MODES.has(sim)) throw new ApiError(400, "INVALID_SIM", `sim phải là một trong: ${[...OCR_MODES].join(", ")}`);
    patch.ocr = { mode: sim };
  }
  const simSave = url.searchParams.get("simSave");
  if (simSave) {
    if (!SAVE_MODES.has(simSave)) throw new ApiError(400, "INVALID_SIM", `simSave phải là một trong: ${[...SAVE_MODES].join(", ")}`);
    patch.save = { mode: simSave };
  }
  return Object.keys(patch).length ? patch : null;
}

/* Lỗi báo "client đã bỏ đi": dùng name AbortError để mọi signal/lớp dưới coi như huỷ bình thường. */
function clientClosedError() {
  return Object.assign(new Error("Client ngắt kết nối trước khi có phản hồi"), {
    name: "AbortError",
    code: "CLIENT_CLOSED_REQUEST",
  });
}

function requireDeviceIdParam(value) {
  if (!isDeviceId(value)) {
    throw new ApiError(400, "INVALID_DEVICE_ID", "x-device-id phải là UUID v4 chữ thường", { deviceId: String(value).slice(0, 64) });
  }
  return value;
}

export function createApp({
  config,
  db,
  storage,
  recognition,
  receipts,
  devices,
  sessions,
  status,
  sim,
  lifecycle,
  outbox,
  master,
  rules,
  events,
  asyncJobs,
  logger,
}) {
  const startedAt = Date.now();

  /* Sổ sự kiện là quan sát, không phải nghiệp vụ: một lỗi ở đây KHÔNG được làm hỏng response.
   * events.write đã nuốt lỗi DB (E4); lớp này nuốt nốt lỗi "type lạ" (E1). */
  const emit = (event) => {
    if (!events) return;
    try {
      events.write(event);
    } catch (err) {
      logger?.warn("events.emit_failed", { type: event?.type, error: err?.message });
    }
  };

  const invalidQuery = (details) => new ApiError(400, "INVALID_QUERY", "Tham số truy vấn không hợp lệ", details);

  const uuidQueryParam = (url, name) => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") return null;
    if (!isUuidV4(raw)) throw invalidQuery({ field: name });
    return raw;
  };

  /* Số trong query string: vắng mặt hoặc rỗng → undefined (handler dùng mặc định của mình);
   * còn lại trả đúng Number(...) kể cả 0 và NaN, để tầng dưới tự quyết định kẹp hay bỏ. */
  const numberQueryParam = (url, name) => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === "") return undefined;
    return Number(raw);
  };

  /* ?status=posting,posted — có khoảng trắng thì trim; rỗng coi như không lọc (không báo lỗi). */
  const statusQueryParam = (url) => {
    const raw = url.searchParams.get("status");
    if (raw === null || raw.trim() === "") return null;
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) return null;
    if (list.length > 8 || list.some((s) => !RECEIPT_STATUSES.includes(s))) {
      throw invalidQuery({ field: "status", allowed: [...RECEIPT_STATUSES] });
    }
    return list;
  };

  const simEnabledOrThrow = () => {
    if (!config.simOverride) throw new ApiError(403, "SIM_DISABLED", SIM_DISABLED_MSG);
  };

  const simConfigError = (errors) => new ApiError(400, "INVALID_SIM_CONFIG", "Kịch bản mô phỏng không hợp lệ", errors);

  const adminSimBody = (extra = {}) => ({
    enabled: config.simOverride,
    default: structuredClone(SIM_DEFAULT),
    global: sim.getGlobal(),
    devices: sim.listDevices(),
    updatedAt: sim.updatedAt(),
    serverTime: new Date().toISOString(),
    ...extra,
  });

  const deviceSimBody = (deviceId, extra = {}) => ({
    enabled: config.simOverride,
    deviceId,
    deviceKnown: devices.get(deviceId) !== null,
    device: sim.getDeviceRaw(deviceId),
    effectiveForDevice: sim.effective({ deviceId }),
    updatedAt: sim.updatedAt(),
    serverTime: new Date().toISOString(),
    ...extra,
  });

  /* Body chung cho register/heartbeat: FE lấy nhịp heartbeat từ đây, không hard-code. */
  const withServerTime = (obj) => ({ ...obj, serverTime: new Date().toISOString(), heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });

  function readDeviceIdFrom(body, ctx, { pathValue = null } = {}) {
    const fromBody = body?.deviceId;
    const fromPath = pathValue;
    const fromHeader = ctx.deviceId;
    for (const candidate of [fromPath, fromBody]) {
      if (candidate === undefined || candidate === null) continue;
      if (typeof candidate !== "string") throw new ApiError(400, "INVALID_DEVICE_ID", "x-device-id phải là UUID v4 chữ thường", { deviceId: String(candidate).slice(0, 64) });
      if (fromHeader && candidate !== fromHeader) {
        throw new ApiError(400, "DEVICE_ID_MISMATCH", "deviceId trong body/đường dẫn không khớp header x-device-id", {
          pathOrBody: candidate.slice(0, 64),
          header: fromHeader,
        });
      }
    }
    const value = fromPath ?? fromBody ?? fromHeader ?? null;
    if (value === null) throw new ApiError(400, "DEVICE_REQUIRED", "Thiếu định danh thiết bị (x-device-id)");
    return requireDeviceIdParam(value);
  }

  function validateRegisterBody(body) {
    if (body !== null && body !== undefined && (typeof body !== "object" || Array.isArray(body))) {
      throw new ApiError(400, "INVALID_BODY", "Body phải là JSON object");
    }
    const b = body || {};
    if (b.network !== undefined && b.network !== null && !NETWORKS.has(b.network)) {
      throw new ApiError(400, "INVALID_BODY", "network không hợp lệ", { field: "network", allowed: [...NETWORKS] });
    }
    return b;
  }

  const coreRoutes = [
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      handler: async () => ({
        status: 200,
        body: {
          ok: true,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          provider: recognition.provider.name,
          mockMode: config.provider === "mock" ? config.mock.mode : null,
          simOverride: config.simOverride,
          simSaveFail: config.simSaveFail,
          db: db.prepare("SELECT 1 AS ok").get().ok === 1 ? "ok" : "error",
          receipts: db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n,
        },
      }),
    },
    {
      method: "GET",
      pattern: /^\/api\/status$/,
      handler: async (_req, _m, _url, _res, ctx) => ({ status: 200, body: await status.build({ deviceId: ctx.deviceId }) }),
    },
    {
      method: "POST",
      pattern: /^\/api\/recognitions$/,
      handler: async (req, _m, url, _res, ctx) => {
        // Validate ?sim trước khi đọc multipart: sai kịch bản thì không tốn công tải ảnh lên.
        const override = simOption(url, config);
        const effective = sim.effective({ deviceId: ctx.deviceId, requestOverride: override });
        const form = await readMultipart(req, config.maxUploadBytes);
        const file = form.get("image");
        if (!file || typeof file === "string") throw new ApiError(400, "IMAGE_REQUIRED", "Thiếu field 'image' dạng file");
        if (file.size > config.maxUploadBytes) {
          throw new ApiError(413, "IMAGE_TOO_LARGE", `Ảnh ${file.size} byte vượt giới hạn ${config.maxUploadBytes} byte`);
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        if (buffer.length === 0) throw new ApiError(400, "IMAGE_EMPTY", "File ảnh rỗng");

        /* RECOGNITION_MODE=async: trả 202 ngay rồi xử lý nền. Mặc định là `sync` nên nhánh
         * này KHÔNG bao giờ chạy với cấu hình mặc định (QUYẾT ĐỊNH A-1). */
        if (config.recognitionMode === "async") {
          // Chuỗi tuỳ ý của FE để khớp kết quả với đúng lượt chụp sau khi reload app; dài hơn thì CẮT.
          const rawCaptureRef = header(req, "x-capture-ref");
          const captureRef = typeof rawCaptureRef === "string" && rawCaptureRef ? rawCaptureRef.slice(0, CAPTURE_REF_MAX) : null;
          const { public: body, jobPromise } = await recognition.runAsync({
            imageBuffer: buffer,
            options: {},
            simOcr: effective.ocr,
            deviceId: ctx.deviceId,
            sessionId: ctx.sessionId,
            requestId: ctx.requestId,
            captureRef,
          });
          asyncJobs?.track(body.recognitionId, jobPromise);
          return {
            status: 202,
            body: {
              ...body,
              pollUrl: `/api/recognitions/${body.recognitionId}`,
              pollAfterMs: config.recognitionPollHintMs,
            },
            headers: {
              location: `/api/recognitions/${body.recognitionId}`,
              "retry-after": String(Math.ceil(config.recognitionPollHintMs / 1000)),
            },
          };
        }

        const result = await recognition.run({
          imageBuffer: buffer,
          options: {},
          simOcr: effective.ocr,
          deviceId: ctx.deviceId,
          sessionId: ctx.sessionId,
          requestId: ctx.requestId,
          clientSignal: ctx.clientSignal,
        });
        return { status: 201, body: result };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/recognitions\/([0-9a-f-]{36})$/,
      handler: async (_req, m) => {
        const r = recognition.get(m[1]);
        if (!r) throw new ApiError(404, "NOT_FOUND", "Không có recognition này");
        return { status: 200, body: r };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/images\/([0-9a-f-]{36})$/,
      handler: async (_req, m, _url, res, ctx) => {
        const meta = storage.getMeta(m[1]);
        if (!meta) throw new ApiError(404, "NOT_FOUND", "Không có ảnh này");
        const buf = await storage.getBuffer(m[1]);
        res.writeHead(200, {
          "content-type": meta.mimeType,
          "content-length": buf.length,
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
          "x-request-id": ctx.requestId,
        });
        res.end(buf);
        return null;
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/receipts$/,
      handler: async (req, _m, url, _res, ctx) => {
        const override = simOption(url, config);
        const body = await readJson(req);
        const effective = sim.effective({ deviceId: ctx.deviceId, requestOverride: override });
        // SIM_SAVE_FAIL=true thắng mọi kịch bản khác cho save.mode (Q7).
        const simSave = config.simSaveFail ? "fail" : effective.save.mode;
        const saveLatencyMs = simSave === "slow" ? Math.max(effective.save.latencyMs, 8000) : 0;
        const { receipt, created } = await receipts.create(body, {
          simSave,
          saveLatencyMs,
          deviceId: ctx.deviceId,
          sessionId: ctx.sessionId,
        });
        return { status: created ? 201 : 200, body: { ...receipt, idempotent: !created } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/receipts$/,
      handler: async (_req, _m, url) => {
        /* limit giữ nguyên hành vi khoan dung của Phase 1 (?limit=abc → 20); cursor thì ngược
         * lại, sai là báo lỗi — cursor hỏng nghĩa là FE đang phân trang sai (Q17). */
        const { items, nextCursor, counts } = receipts.list({
          sessionId: uuidQueryParam(url, "sessionId"),
          deviceId: uuidQueryParam(url, "deviceId"),
          statuses: statusQueryParam(url),
          /* Chuyển nguyên giá trị đã parse xuống receipts.list() để nó kẹp: `|| 20` ở đây sẽ
           * biến ?limit=0 thành 20 dòng thay vì kẹp về 1 (§2.1). */
          limit: numberQueryParam(url, "limit"),
          cursor: url.searchParams.get("cursor") || null,
        });
        return { status: 200, body: { items, nextCursor, counts, serverTime: new Date().toISOString() } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/receipts\/([0-9a-f-]{36})$/,
      handler: async (_req, m) => {
        const r = receipts.get(m[1]);
        if (!r) throw new ApiError(404, "NOT_FOUND", "Không có bản ghi này");
        return { status: 200, body: r };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/receipts\/([0-9a-f-]{36})\/events$/,
      handler: async (_req, m) => {
        // Phiếu có thật nhưng chưa có sự kiện nào (phiếu backfill) → 200 với items rỗng, KHÔNG 404.
        if (!receipts.get(m[1])) throw new ApiError(404, "NOT_FOUND", "Không có bản ghi này");
        return {
          status: 200,
          body: { receiptId: m[1], items: lifecycle.events(m[1]), serverTime: new Date().toISOString() },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/receipts\/([0-9a-f-]{36})\/retry-post$/,
      handler: async (req, m, _url, _res, ctx) => {
        await readJson(req); // Q20: vẫn bắt buộc content-type: application/json, body bị bỏ qua
        const receiptId = m[1];
        const receipt = receipts.get(receiptId);
        if (!receipt) throw new ApiError(404, "NOT_FOUND", "Không có bản ghi này");
        if (config.sap.adapter === "none") {
          throw new ApiError(409, "SAP_NOT_CONFIGURED", "Chưa cấu hình kết nối SAP", { adapter: "none" });
        }
        if (receipt.status !== "post_failed") {
          throw new ApiError(409, "RECEIPT_STATE_INVALID", "Không thực hiện được thao tác này với trạng thái hiện tại của phiếu", {
            current: receipt.status,
            allowed: ["post_failed"],
          });
        }
        const now = new Date().toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
          outbox.requeue({ receiptId, kind: "post", nowIso: now });
          lifecycle.transition(
            {
              receiptId,
              to: "posting",
              event: "receipt.retry_requested",
              actorKind: "operator",
              deviceId: ctx.deviceId,
              sessionId: ctx.sessionId,
              detail: {},
              expectFrom: ["post_failed"],
            },
            { inTransaction: true },
          );
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        /* 202 chứ không 200 (Q21): việc gửi SAP CHƯA xảy ra lúc trả lời — worker nhặt job ở
         * tick kế tiếp. Trả 200 sẽ làm FE tưởng đã posted. */
        return {
          status: 202,
          body: { receiptId, status: "posting", attempts: 0, nextAttemptAt: now, serverTime: new Date().toISOString() },
        };
      },
    },

    /* ---------- Thiết bị ---------- */
    {
      method: "POST",
      pattern: /^\/api\/devices\/register$/,
      handler: async (req, _m, _url, _res, ctx) => {
        const body = validateRegisterBody(await readJson(req));
        const deviceId = readDeviceIdFrom(body, ctx);
        const { device, created } = devices.register({
          deviceId,
          name: body.name,
          appVersion: body.appVersion,
          platform: body.platform,
          network: body.network,
          screen: body.screen,
          meta: body.meta,
        });
        if (created) {
          emit({
            type: "device.registered",
            deviceId,
            detail: { name: device.name, appVersion: device.appVersion, platform: device.platform },
          });
        }
        return { status: created ? 201 : 200, body: withServerTime({ device, created }) };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/devices\/([0-9a-f-]{36})\/heartbeat$/,
      handler: async (req, m, _url, _res, ctx) => {
        const body = validateRegisterBody(await readJson(req));
        const deviceId = readDeviceIdFrom(body, ctx, { pathValue: m[1] });
        const device = devices.heartbeat(deviceId, {
          appVersion: body.appVersion,
          network: body.network,
          battery: body.battery === undefined ? undefined : clampBattery(body.battery),
          pendingQueue: body.pendingQueue === undefined ? undefined : Math.max(0, Number.parseInt(body.pendingQueue, 10) || 0),
          screen: body.screen,
          /* `meta` đi trọn đường từ body heartbeat tới GET /api/devices: đó là nguồn DUY NHẤT
           * của `meta.netSim`, thứ cột «Mạng» của S9 dùng để hiện kịch bản mạng đang áp
           * (`01-simulation-matrix.md` §4). Vắng khoá này thì `devices.update()` giữ nguyên
           * meta cũ — FE không gửi meta sẽ không bị xoá mất meta đã có. */
          meta: body.meta,
        });
        if (!device) throw new ApiError(404, "DEVICE_NOT_FOUND", "Thiết bị chưa đăng ký", { deviceId });
        return { status: 200, body: withServerTime({ ok: true, device }) };
      },
    },
    /* PDA báo sự kiện quan sát lên (§4.5). Endpoint GHI mới duy nhất ngoài /api/admin/, nên nó
     * CHỊU sim middleware như mọi endpoint ghi khác: backend.mode=readonly chặn nó bằng
     * 503 BACKEND_READONLY (QUYẾT ĐỊNH A-10). Cố ý KHÔNG thêm vào DEVICE_SELF_MANAGED (nó nên
     * touch như mọi request khác) và KHÔNG thêm vào DEVICE_REQUIRED_PATHS. */
    {
      method: "POST",
      pattern: /^\/api\/devices\/([0-9a-f-]{36})\/events$/,
      handler: async (req, m, _url, _res, ctx) => {
        const body = await readJson(req);
        const deviceId = readDeviceIdFrom(body && typeof body === "object" ? body : {}, ctx, { pathValue: m[1] });
        if (!devices.get(deviceId)) throw new ApiError(404, "DEVICE_NOT_FOUND", "Thiết bị chưa đăng ký", { deviceId });

        const list = body?.events;
        if (!Array.isArray(list) || list.length === 0 || list.length > MAX_DEVICE_EVENTS) {
          throw new ApiError(400, "INVALID_BODY", `events phải là mảng 1–${MAX_DEVICE_EVENTS} phần tử`, {
            field: "events",
            max: MAX_DEVICE_EVENTS,
          });
        }
        /* Validate TOÀN BỘ lô TRƯỚC khi ghi (QUYẾT ĐỊNH A-9): một phần tử sai → 400 và KHÔNG
         * ghi phần tử nào. Ghi một phần rồi báo lỗi sẽ khiến FE không biết gửi lại từ đâu. */
        const rows = list.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new ApiError(400, "INVALID_BODY", "Mỗi phần tử của events phải là JSON object", { field: "events" });
          }
          if (!CLIENT_EVENT_TYPES.includes(item.type)) {
            throw new ApiError(400, "INVALID_EVENT_TYPE", "Loại sự kiện không thuộc danh sách thiết bị được phép gửi", {
              type: typeof item.type === "string" ? item.type.slice(0, 64) : String(item.type).slice(0, 64),
              allowed: [...CLIENT_EVENT_TYPES],
            });
          }
          /* `at` của client vào cột client_at và CHỈ để tham khảo; cột `at` luôn là giờ SERVER.
           * Sai định dạng thì bỏ qua, không báo lỗi. */
          return {
            type: item.type,
            deviceId,
            sessionId: ctx.sessionId,
            clientAt: item.at,
            detail: item.detail,
          };
        });
        const accepted = events ? events.writeMany(rows) : 0;
        return { status: 202, body: { accepted, rejected: 0, serverTime: new Date().toISOString() } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/devices$/,
      handler: async () => {
        const { items, counts } = devices.list();
        return { status: 200, body: { items, counts, serverTime: new Date().toISOString() } };
      },
    },

    /* ---------- Phiên làm việc ---------- */
    {
      method: "POST",
      pattern: /^\/api\/sessions\/start$/,
      handler: async (req, _m, _url, _res, ctx) => {
        const raw = await readJson(req);
        if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
          throw new ApiError(400, "INVALID_BODY", "Body phải là JSON object");
        }
        const body = raw || {};
        if (body.shift !== undefined && body.shift !== null && !SHIFTS.has(body.shift)) {
          throw new ApiError(400, "INVALID_BODY", "shift không hợp lệ", { field: "shift", allowed: [...SHIFTS] });
        }
        const deviceId = readDeviceIdFrom(body, ctx);
        devices.touch(deviceId); // tự đăng ký ngầm (Q3): không chặn giữa ca vì DB bị xoá
        const { session, supersededSessionId } = sessions.start({
          deviceId,
          operator: body.operator,
          warehouse: body.warehouse,
          shift: body.shift ?? null,
        });
        /* BE tự ghi session.started ở ĐÚNG MỘT chỗ: đó là lý do `session.started` KHÔNG nằm
         * trong danh sách trắng client — để PDA gửi thêm sẽ thành hai dòng cho cùng một việc. */
        emit({
          type: "session.started",
          deviceId,
          sessionId: session.id,
          detail: { operator: session.operator, warehouse: session.warehouse, shift: session.shift },
        });
        if (supersededSessionId) {
          const prev = sessions.get(supersededSessionId);
          emit({
            type: "session.ended",
            deviceId,
            sessionId: supersededSessionId,
            detail: {
              reason: "superseded",
              receipts: prev?.summary?.receipts ?? 0,
              recognitionsFailed: prev?.summary?.recognitionsFailed ?? 0,
            },
          });
        }
        return { status: 201, body: { session, supersededSessionId, serverTime: new Date().toISOString() } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/([0-9a-f-]{36})\/end$/,
      handler: async (req, m) => {
        const raw = await readJson(req);
        const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        if (body.reason !== undefined && body.reason !== null && !END_REASONS.has(body.reason)) {
          throw new ApiError(400, "INVALID_BODY", "reason không hợp lệ", { field: "reason", allowed: [...END_REASONS] });
        }
        const out = sessions.end(m[1], body.reason ?? "manual");
        if (!out) throw new ApiError(404, "SESSION_NOT_FOUND", "Không có phiên làm việc này", { sessionId: m[1] });
        // Đóng lại phiên đã đóng là idempotent (không đổi gì) → không ghi thêm một dòng sự kiện.
        if (!out.alreadyEnded) {
          emit({
            type: "session.ended",
            deviceId: out.session.deviceId,
            sessionId: out.session.id,
            detail: {
              reason: out.session.endReason,
              receipts: out.session.summary?.receipts ?? 0,
              recognitionsFailed: out.session.summary?.recognitionsFailed ?? 0,
            },
          });
        }
        return { status: 200, body: { ...out, serverTime: new Date().toISOString() } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/sessions\/([0-9a-f-]{36})$/,
      handler: async (_req, m) => {
        const session = sessions.get(m[1]);
        if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "Không có phiên làm việc này", { sessionId: m[1] });
        return { status: 200, body: { session, serverTime: new Date().toISOString() } };
      },
    },

    /* ---------- Quản trị kịch bản mô phỏng ---------- */
    {
      method: "GET",
      pattern: /^\/api\/admin\/sim$/,
      handler: async () => {
        simEnabledOrThrow();
        return { status: 200, body: adminSimBody() };
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/admin\/sim$/,
      handler: async (req) => {
        simEnabledOrThrow();
        const patch = await readJson(req);
        const { ok, errors } = validateScenarioPatch(patch);
        if (!ok) throw simConfigError(errors);
        sim.setGlobal(patch);
        emit({ type: "sim.updated", detail: { scope: "global", patch } });
        return { status: 200, body: adminSimBody() };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/admin\/sim$/,
      handler: async () => {
        simEnabledOrThrow();
        sim.clearGlobal();
        emit({ type: "sim.cleared", detail: { scope: "global" } });
        return { status: 200, body: adminSimBody({ cleared: "global" }) };
      },
    },
    /* Pattern nới rộng có chủ đích (§7.3): mọi chuỗi đều vào được route để
     * requireDeviceIdParam trả 400 INVALID_DEVICE_ID, thay vì rơi ra 404 NOT_FOUND —
     * người vận hành phải biết mình gõ sai id chứ không phải sai đường dẫn. */
    {
      method: "PUT",
      pattern: /^\/api\/admin\/sim\/devices\/([^/]{1,128})$/,
      handler: async (req, m) => {
        simEnabledOrThrow();
        const deviceId = requireDeviceIdParam(m[1]);
        const patch = await readJson(req);
        const { ok, errors } = validateScenarioPatch(patch);
        if (!ok) throw simConfigError(errors);
        sim.setDevice(deviceId, patch);
        emit({ type: "sim.updated", deviceId, detail: { scope: `device:${deviceId}`, patch } });
        return { status: 200, body: deviceSimBody(deviceId) };
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/admin\/sim\/devices\/([^/]{1,128})$/,
      handler: async (_req, m) => {
        simEnabledOrThrow();
        const deviceId = requireDeviceIdParam(m[1]);
        sim.clearDevice(deviceId);
        emit({ type: "sim.cleared", deviceId, detail: { scope: `device:${deviceId}` } });
        return { status: 200, body: deviceSimBody(deviceId, { cleared: "device" }) };
      },
    },
  ];

  /* Chỗ cắm route của BE-2, nối vào CUỐI mảng (Q36): routes.find lấy khớp ĐẦU TIÊN nên route
   * lõi luôn thắng, BE-2 không thể vô tình ghi đè endpoint của BE-1. */
  const routes = [
    ...coreRoutes,
    ...extraRoutes({ config, db, receipts, sessions, lifecycle, outbox, master, rules, events, recognition, logger, ApiError }),
  ];

  const corsAllowed = (origin) => {
    if (!origin || config.corsOrigins.length === 0) return false;
    return config.corsOrigins.includes("*") || config.corsOrigins.includes(origin.replace(/\/+$/, ""));
  };

  /* Hai endpoint tự quản dòng device (tự ghi last_seen, tự quyết định 201/200/404) nên
   * KHÔNG đi qua touch: touch trước sẽ làm register không bao giờ báo được created=true và
   * làm heartbeat không bao giờ trả được 404 cho device chưa đăng ký (Q3). */
  const DEVICE_SELF_MANAGED = /^\/api\/devices\/(register|[0-9a-f-]{36}\/heartbeat)$/;
  const DEVICE_REQUIRED_PATHS = [
    { method: "POST", pattern: /^\/api\/recognitions$/ },
    { method: "POST", pattern: /^\/api\/receipts$/ },
  ];

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://local");

    // x-request-id đặt đầu tiên: mọi response, kể cả 403/404/405/503, đều phải mang nó.
    const ctx = { requestId: normalizeRequestId(req.headers["x-request-id"]), deviceId: null, sessionId: null, clientSignal: null };
    res.setHeader("x-request-id", ctx.requestId);

    /* PDA rút ứng dụng / mất sóng giữa chừng: giữ slot semaphore và gọi tiếp provider cho một
     * người đã bỏ đi là phí tài nguyên của những người còn chờ. res "close" trước khi response
     * kết thúc (hoặc req "aborted") = client đã đi → huỷ lời gọi và trả slot ngay. */
    const clientGone = new AbortController();
    const abortIfClientLeft = () => {
      if (!res.writableEnded && !clientGone.signal.aborted) clientGone.abort(clientClosedError());
    };
    res.on("close", abortIfClientLeft);
    req.on("aborted", abortIfClientLeft);
    ctx.clientSignal = clientGone.signal;

    const done = (st) =>
      logger?.info("http", {
        method: req.method,
        path: url.pathname,
        status: st,
        ms: Date.now() - t0,
        requestId: ctx.requestId,
        deviceId: ctx.deviceId,
        sessionId: ctx.sessionId,
      });

    // CORS: chỉ khi CORS_ORIGINS được cấu hình và origin nằm trong danh sách.
    const origin = req.headers.origin;
    if (corsAllowed(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type, authorization, x-device-id, x-session-id, x-request-id, x-app-version");
      res.setHeader("access-control-expose-headers", "x-request-id, retry-after");
      res.setHeader("access-control-max-age", "600");
    }
    /* Preflight trả lời trước sim middleware: chặn OPTIONS làm browser báo lỗi CORS mơ hồ
     * thay vì 503 đọc được. */
    if (req.method === "OPTIONS") {
      res.writeHead(corsAllowed(origin) ? 204 : 403);
      res.end();
      return done(res.statusCode);
    }

    try {
      const deviceHeader = header(req, "x-device-id");
      if (deviceHeader !== undefined && deviceHeader !== "") {
        /* /api/status là đường sống duy nhất để PDA biết chuyện gì đang xảy ra (§5): nó không
         * được từ chối vì một header phụ. x-device-id hỏng (localStorage bị sửa tay) → bỏ qua
         * im lặng như đã làm với x-session-id, coi như không có device, vẫn trả 200. */
        if (url.pathname === "/api/status" && !isDeviceId(deviceHeader)) {
          logger?.warn("device.header_ignored", { path: url.pathname, requestId: ctx.requestId });
        } else {
          ctx.deviceId = requireDeviceIdParam(deviceHeader);
        }
      }
      // x-session-id sai định dạng: bỏ qua im lặng. Phiên nằm trong localStorage của FE,
      // có thể cũ — không được chặn thao tác vì nó.
      const sessionHeader = header(req, "x-session-id");
      if (sessionHeader && isUuidV4(sessionHeader)) ctx.sessionId = sessionHeader;

      /* /api/status là ĐỌC trạng thái, không phải dấu hiệu sống → không làm tươi last_seen,
       * nếu không một tab mở suốt ngày sẽ mãi "online" (Q4). */
      if (ctx.deviceId && url.pathname !== "/api/status" && !DEVICE_SELF_MANAGED.test(url.pathname)) {
        devices.touch(ctx.deviceId);
      }

      const decision = decideSim({
        method: req.method,
        pathname: url.pathname,
        effective: sim.effective({ deviceId: ctx.deviceId }),
        simOverride: config.simOverride,
      });
      if (decision.latencyMs > 0) await sleep(decision.latencyMs);
      if (decision.action === "block") {
        sendError(res, decision.status, decision.code, decision.message, decision.details, {
          "retry-after": String(Math.ceil(decision.details.retryAfterMs / 1000)),
        });
        return done(res.statusCode);
      }

      const needsDevice = DEVICE_REQUIRED_PATHS.some((p) => p.method === req.method && p.pattern.test(url.pathname));
      if (needsDevice && !ctx.deviceId) {
        if (config.requireDeviceId) throw new ApiError(400, "DEVICE_REQUIRED", "Thiếu định danh thiết bị (x-device-id)");
        logger?.warn("device.missing", { path: url.pathname, requestId: ctx.requestId });
      }

      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) {
        const anyMethod = routes.some((r) => r.pattern.test(url.pathname));
        if (anyMethod) sendError(res, 405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ cho đường dẫn này");
        else sendError(res, 404, "NOT_FOUND", "Không có đường dẫn này");
        return done(res.statusCode);
      }
      const out = await route.handler(req, url.pathname.match(route.pattern), url, res, ctx);
      // out.headers: nhánh 202 của chế độ async cần `location` + `retry-after`.
      if (out) sendJson(res, out.status, out.body, out.headers || {});
      done(res.statusCode);
    } catch (err) {
      // Không còn ai để trả lời: chỉ ghi log rồi đóng, đừng cố ghi vào socket đã chết.
      if (clientGone.signal.aborted && !res.writableEnded) {
        logger?.warn("http.client_gone", {
          method: req.method,
          path: url.pathname,
          ms: Date.now() - t0,
          requestId: ctx.requestId,
          deviceId: ctx.deviceId,
        });
        if (!res.destroyed) res.destroy();
        return;
      }
      if (err instanceof ApiError || err instanceof ReceiptError) {
        sendError(res, err.status, err.code, err.message, err.details);
      } else if (err instanceof RecognitionBusyError) {
        emit({
          type: "recognition.rejected_busy",
          deviceId: ctx.deviceId,
          sessionId: ctx.sessionId,
          detail: {
            inflight: err.details?.inflight ?? null,
            waiting: err.details?.waiting ?? null,
            retryAfterMs: err.details?.retryAfterMs ?? null,
          },
        });
        sendError(res, 429, err.code, err.message, err.details, {
          "retry-after": String(Math.ceil(err.details.retryAfterMs / 1000)),
        });
      } else if (err instanceof RecognitionError) {
        const status = err.code === "RECOGNITION_TIMEOUT" ? 504 : err.code === "PROVIDER_NOT_CONFIGURED" ? 503 : 502;
        sendError(res, status, err.code, err.message, { recognitionId: err.recognitionId, imageId: err.imageId });
      } else if (err?.code === "UNSUPPORTED_IMAGE") {
        sendError(res, 415, "UNSUPPORTED_IMAGE", "Chỉ nhận ảnh JPEG, PNG hoặc WebP");
      } else {
        logger?.error("http.unhandled", { method: req.method, path: url.pathname, error: err?.message, stack: err?.stack, requestId: ctx.requestId });
        sendError(res, 500, "INTERNAL_ERROR", "Lỗi không mong đợi phía server");
      }
      done(res.statusCode);
    }
  });

  // Upload ảnh trên Wi-Fi kho có thể chậm; nới timeout header/request.
  server.headersTimeout = 65_000;
  server.requestTimeout = 120_000;
  return server;
}
