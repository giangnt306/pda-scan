import crypto from "node:crypto";
import { validateReceiptData, FIELD_KEYS } from "./fields.js";
import { isUniqueViolation } from "./db.js";
import { RECEIPT_STATUSES } from "./lifecycle.js";

const SOURCES = new Set(["camera", "barcode", "manual"]);
const VIAS = new Set(["ai", "scan", "manual"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ReceiptError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* JSON với key sắp xếp để hash không phụ thuộc thứ tự client gửi. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const payloadHash = (obj) => crypto.createHash("sha256").update(canonicalJson(obj)).digest("hex");

/* Chỉ giữ metadata nguồn đúng dạng; bỏ phần thừa để không lưu rác. */
function sanitizeFieldMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== "object") return out;
  for (const key of FIELD_KEYS) {
    const m = meta[key];
    if (!m || typeof m !== "object") continue;
    const via = VIAS.has(m.via) ? m.via : "manual";
    const conf = Number(m.confidence);
    out[key] = {
      via,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
      edited: Boolean(m.edited),
      proposed: m.proposed === undefined ? null : m.proposed,
    };
  }
  return out;
}

/* Phiếu huỷ được từ 6 trạng thái; cancelled (đã huỷ) và superseded (đóng băng) thì không. */
export const CANCELLABLE_FROM = ["confirmed", "posting", "posted", "post_failed", "rejected", "corrected"];
/* Sửa được từ 5 trạng thái. posted đã có chứng từ SAP → phải cancel rồi nhập phiếu mới. */
export const CORRECTABLE_FROM = ["confirmed", "posting", "post_failed", "rejected", "corrected"];

export const RECEIPT_STATE_INVALID_MSG = "Không thực hiện được thao tác này với trạng thái hiện tại của phiếu";

const encodeCursor = (createdAt, rowid) => Buffer.from(`${createdAt}|${rowid}`).toString("base64url");

/* Cursor hỏng nghĩa là client đang phân trang sai: im lặng trả trang 1 sẽ làm FE lặp vô hạn (Q17). */
function decodeCursor(cursor) {
  const bad = () =>
    new ReceiptError(400, "INVALID_CURSOR", "Con trỏ phân trang không hợp lệ", { cursor: String(cursor).slice(0, 64) });
  if (typeof cursor !== "string" || cursor === "") throw bad();
  let raw;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw bad();
  }
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) throw bad();
  const createdAt = raw.slice(0, sep);
  const rowid = Number(raw.slice(sep + 1));
  if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt) || !Number.isInteger(rowid)) throw bad();
  return { createdAt, rowid };
}

export function createReceiptService({ db, config, logger, lifecycle, outbox, rules, sessions }) {
  /* postAttempts đọc từ outbox.attempts khi job còn sống, và từ receipts.post_attempts khi job
   * đã bị xoá (phiếu posted/rejected) — nhờ vậy phiếu đang retry cũng cho biết đã thử mấy lần. */
  const RECEIPT_SELECT =
    "SELECT r.*, o.attempts AS ob_attempts FROM receipts r LEFT JOIN outbox o ON o.receipt_id = r.id AND o.kind = 'post'";
  const selectByRequest = db.prepare(`${RECEIPT_SELECT} WHERE r.request_id = ?`);
  const selectById = db.prepare(`${RECEIPT_SELECT} WHERE r.id = ?`);
  const selectRecognition = db.prepare("SELECT id, image_id, status FROM recognitions WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO receipts (id, request_id, recognition_id, image_id, source, data, field_meta, payload_hash, client_info, created_at, device_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const sapEnabled = () => config?.sap?.adapter && config.sap.adapter !== "none";

  const toPublic = (row) => ({
    receiptId: row.id,
    requestId: row.request_id,
    recognitionId: row.recognition_id,
    imageId: row.image_id,
    imageUrl: row.image_id ? `/api/images/${row.image_id}` : null,
    source: row.source,
    deviceId: row.device_id ?? null,
    sessionId: row.session_id ?? null,
    /* Lưới an toàn cuối cùng: kể cả khi backfill chưa chạy, response vẫn hợp lệ. */
    status: row.status ?? "confirmed",
    sapDocumentNo: row.sap_document_no ?? null,
    supersedesReceiptId: row.supersedes ?? null,
    supersededByReceiptId: row.superseded_by ?? null,
    rejectCode: row.reject_code ?? null,
    postAttempts: row.ob_attempts ?? row.post_attempts ?? 0,
    cancelReason: row.cancel_reason ?? null,
    data: JSON.parse(row.data),
    fieldMeta: JSON.parse(row.field_meta),
    client: row.client_info ? JSON.parse(row.client_info) : null,
    createdAt: row.created_at,
  });

  return {
    /* Trả { receipt, created }. created=false khi requestId đã lưu trước đó với cùng payload.
     * simSave: normal | fail | slow (kịch bản mô phỏng đã trộn xong ở tầng HTTP). */
    async create(body, { simSave = "normal", saveLatencyMs = 0, deviceId = null, sessionId = null } = {}) {
      if (!body || typeof body !== "object") throw new ReceiptError(400, "INVALID_BODY", "Body phải là JSON object");
      const { requestId, recognitionId = null, source, data, fieldMeta, client } = body;

      if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
        throw new ReceiptError(400, "INVALID_REQUEST_ID", "requestId phải là chuỗi 8–128 ký tự [A-Za-z0-9_-]");
      }
      if (recognitionId !== null && typeof recognitionId !== "string") {
        throw new ReceiptError(400, "INVALID_RECOGNITION_ID", "recognitionId phải là chuỗi hoặc null");
      }
      if (!SOURCES.has(source)) {
        throw new ReceiptError(400, "INVALID_SOURCE", `source phải là một trong: ${[...SOURCES].join(", ")}`);
      }
      if (body.allowDuplicate !== undefined && typeof body.allowDuplicate !== "boolean") {
        throw new ReceiptError(400, "INVALID_BODY", "allowDuplicate phải là boolean", { field: "allowDuplicate" });
      }

      const validation = validateReceiptData(data);
      if (!validation.ok) {
        throw new ReceiptError(422, "VALIDATION_FAILED", "Dữ liệu chưa hợp lệ", { fields: validation.errors });
      }

      let imageId = null;
      if (recognitionId) {
        const rec = selectRecognition.get(recognitionId);
        if (!rec) throw new ReceiptError(422, "RECOGNITION_NOT_FOUND", "recognitionId không tồn tại");
        imageId = rec.image_id;
      }

      const hash = payloadHash({ recognitionId, source, data: validation.data });

      /* ⭐ Idempotency TRƯỚC mọi rule nghiệp vụ (Q30). Nếu rule chạy trước, một lần retry save
       * của transport.js (cùng requestId) sẽ tự phát hiện chính mình là trùng nhãn và trả 409
       * cho một phiếu chưa hề tồn tại. */
      const existing = selectByRequest.get(requestId);
      if (existing) return this.resolveExisting(existing, hash);

      /* rules tự ném ReceiptError 422 LOCATION_UNKNOWN / 409 DUPLICATE_LABEL — không bắt ở đây. */
      const { duplicateOf } = rules.checkBeforeCreate({
        data: validation.data,
        sessionId,
        deviceId,
        allowDuplicate: body.allowDuplicate === true,
        nowIso: new Date().toISOString(),
      });

      if (simSave === "fail") {
        // Mô phỏng lỗi lưu (DB/đĩa). Khác hẳn với OCR lỗi: xảy ra ở bước xác nhận.
        throw new ReceiptError(503, "SAVE_FAILED_SIMULATED", "Mô phỏng: không lưu được bản ghi, hãy thử lại");
      }
      // Chậm chứ không hỏng: phiếu vẫn được lưu, chỉ để PDA thấy "đang lưu" kéo dài.
      if (saveLatencyMs > 0) await sleep(saveLatencyMs);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const meta = sanitizeFieldMeta(fieldMeta);
      const fieldsEdited = Object.values(meta).filter((m) => m.edited === true).length;
      /* Phiếu + sự kiện confirmed + job outbox nằm trong MỘT transaction: không bao giờ có
       * phiếu đã lưu mà không có job gửi SAP, cũng không có job trỏ tới phiếu không tồn tại. */
      db.exec("BEGIN IMMEDIATE");
      try {
        insert.run(
          id,
          requestId,
          recognitionId,
          imageId,
          source,
          JSON.stringify(validation.data),
          JSON.stringify(meta),
          hash,
          client && typeof client === "object" ? JSON.stringify(client) : null,
          now,
          deviceId,
          sessionId,
        );
        lifecycle.transition(
          {
            receiptId: id,
            to: "confirmed",
            event: "receipt.confirmed",
            actorKind: "device",
            deviceId,
            sessionId,
            detail: { source, requestId, fieldsEdited },
          },
          { inTransaction: true },
        );
        if (sapEnabled()) outbox.enqueue({ receiptId: id, kind: "post", nowIso: now });
        if (duplicateOf) {
          lifecycle.note(
            {
              receiptId: id,
              event: "receipt.duplicate_override",
              actorKind: "device",
              deviceId,
              sessionId,
              detail: { existingReceiptId: duplicateOf.receiptId, key: duplicateOf.key ?? {} },
            },
            { inTransaction: true },
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        // Hai request cùng requestId chạy sát nhau: unique constraint bắt được; đọc lại và so hash.
        if (isUniqueViolation(err)) return this.resolveExisting(selectByRequest.get(requestId), hash);
        throw err;
      }
      // Đọc lại từ DB: chỉ trả về những gì đã thực sự nằm trong SQLite.
      const saved = selectById.get(id);
      logger?.info("receipt.created", { receiptId: id, requestId, recognitionId, source });
      return { receipt: toPublic(saved), created: true };
    },

    resolveExisting(row, hash) {
      if (row.payload_hash === hash) {
        logger?.info("receipt.idempotent", { receiptId: row.id, requestId: row.request_id });
        return { receipt: toPublic(row), created: false };
      }
      throw new ReceiptError(409, "REQUEST_ID_CONFLICT", "requestId này đã được lưu với nội dung khác", {
        receiptId: row.id,
        createdAt: row.created_at,
      });
    },

    get(id) {
      const row = selectById.get(id);
      return row ? toPublic(row) : null;
    },

    toPublic,

    /* Phân trang KEYSET, không offset: offset cho kết quả sai khi có phiếu mới chèn vào giữa
     * lúc người dùng đang cuộn — đúng cảnh thường gặp ở kho (Q18).
     * list(3) (cách gọi số nguyên của Phase 1) vẫn chạy. */
    list(opts = {}) {
      const o = typeof opts === "number" ? { limit: opts } : (opts ?? {});
      const { sessionId = null, deviceId = null, statuses = null, cursor = null } = o;
      /* Hai bước tách bạch (§2.1): không parse được → mặc định 20; parse được nhưng ngoài
       * khoảng → KẸP về [1, 200]. Viết gộp `Number(o.limit) || 20` sẽ nuốt mất số 0 và trả 20
       * dòng cho limit=0. */
      const rawLimit = Number(o.limit);
      const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 20), 200);

      const where = [];
      const args = [];
      if (sessionId) {
        where.push("r.session_id = ?");
        args.push(sessionId);
      }
      if (deviceId) {
        where.push("r.device_id = ?");
        args.push(deviceId);
      }
      /* counts BỎ QUA bộ lọc status (Q19) — nếu không, chip lọc trên S6 về 0 ngay khi bấm. */
      const scopeWhere = where.slice();
      const scopeArgs = args.slice();

      if (statuses?.length) {
        where.push(`COALESCE(r.status, 'confirmed') IN (${statuses.map(() => "?").join(", ")})`);
        args.push(...statuses);
      }
      if (cursor) {
        const { createdAt, rowid } = decodeCursor(cursor);
        where.push("(r.created_at < ? OR (r.created_at = ? AND r.rowid < ?))");
        args.push(createdAt, createdAt, rowid);
      }

      const sql =
        "SELECT r.rowid AS _rowid, r.*, o.attempts AS ob_attempts FROM receipts r" +
        " LEFT JOIN outbox o ON o.receipt_id = r.id AND o.kind = 'post'" +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        " ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?";
      // Đọc limit + 1 để biết còn trang sau mà không cần COUNT.
      const rows = db.prepare(sql).all(...args, limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(last.created_at, last._rowid) : null;

      const byStatus = Object.fromEntries(RECEIPT_STATUSES.map((s) => [s, 0]));
      const countSql =
        "SELECT COALESCE(r.status, 'confirmed') AS s, COUNT(*) AS n FROM receipts r" +
        (scopeWhere.length ? ` WHERE ${scopeWhere.join(" AND ")}` : "") +
        " GROUP BY s";
      let total = 0;
      for (const row of db.prepare(countSql).all(...scopeArgs)) {
        if (byStatus[row.s] === undefined) continue; // trạng thái lạ trong DB không làm vỡ 8 key
        byStatus[row.s] += row.n;
        total += row.n;
      }

      return { items: page.map(toPublic), nextCursor, counts: { total, byStatus } };
    },

    /* BE-1 viết, BE-2 gọi từ routes/rules.js (L11): cả ba bảng receipts/outbox/receipt_events
     * đều là tài sản của BE-1. Phần nghiệp vụ (ai được huỷ, lý do bắt buộc không) là của BE-2. */
    cancel({ receiptId, reason, deviceId = null, sessionId = null } = {}) {
      const row = selectById.get(receiptId);
      if (!row) throw new ReceiptError(404, "NOT_FOUND", "Không có bản ghi này");
      const current = row.status ?? "confirmed";
      if (!CANCELLABLE_FROM.includes(current)) {
        throw new ReceiptError(409, "RECEIPT_STATE_INVALID", RECEIPT_STATE_INVALID_MSG, {
          current,
          allowed: [...CANCELLABLE_FROM],
        });
      }
      const hadSapDocumentNo = Boolean(row.sap_document_no);
      let reversalQueued = false;
      const now = new Date().toISOString();

      db.exec("BEGIN IMMEDIATE");
      try {
        outbox.removeFor(receiptId, "post"); // huỷ rồi thì đừng gửi nữa
        lifecycle.transition(
          {
            receiptId,
            to: "cancelled",
            event: "receipt.cancelled",
            actorKind: "operator",
            deviceId,
            sessionId,
            detail: { reason, hadSapDocumentNo },
            patch: { cancel_reason: reason },
            expectFrom: CANCELLABLE_FROM,
          },
          { inTransaction: true },
        );
        /* Chứng từ đã tồn tại trong SAP: sap_document_no KHÔNG bị xoá, reversal là chứng từ khác. */
        if (current === "posted" && sapEnabled()) {
          outbox.enqueue({ receiptId, kind: "reversal", nowIso: now });
          lifecycle.note(
            {
              receiptId,
              event: "receipt.reversal_queued",
              actorKind: "system",
              detail: { sapDocumentNo: row.sap_document_no },
            },
            { inTransaction: true },
          );
          reversalQueued = true;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      logger?.info("receipt.cancelled", { receiptId, reversalQueued });
      return { receipt: toPublic(selectById.get(receiptId)), reversalQueued };
    },

    /* Sửa phiếu = tạo phiếu MỚI trỏ về phiếu cũ. Không bao giờ ghi đè.
     * Trả { receipt, oldReceipt, created }; created=false khi requestId này đã tạo đúng phiếu
     * sửa đó với cùng nội dung (lần gửi lại của transport.js). */
    createCorrection({ oldReceiptId, requestId, data, fieldMeta = {}, reason = null, deviceId = null, sessionId = null } = {}) {
      const old = selectById.get(oldReceiptId);
      if (!old) throw new ReceiptError(404, "NOT_FOUND", "Không có bản ghi này");
      /* Q23: ảnh và recognition kế thừa nguyên từ phiếu cũ — nhãn không đổi khi sửa số lượng. */
      const hash = payloadHash({ recognitionId: old.recognition_id, source: old.source, data });

      /* ⭐ Idempotency TRƯỚC khi kiểm trạng thái, cùng tinh thần Q30 của POST /api/receipts.
       * transport.js gửi lại cùng requestId khi response rớt trên đường về; lúc đó phiếu sửa ĐÃ
       * tồn tại và phiếu cũ đã superseded, nên kiểm trạng thái trước sẽ trả 409 cho một thao tác
       * đã thành công — người vận hành tưởng hỏng và sửa thêm lần nữa (hai phiếu cho một lần sửa).
       * Kiểm requestId cũng là đường trả REQUEST_ID_CONFLICT (Q24) trước khi SQLite ném UNIQUE. */
      const taken = selectByRequest.get(requestId);
      if (taken) return this.resolveExistingCorrection(taken, { oldReceiptId, hash, old });

      const current = old.status ?? "confirmed";
      if (!CORRECTABLE_FROM.includes(current)) {
        throw new ReceiptError(409, "RECEIPT_STATE_INVALID", RECEIPT_STATE_INVALID_MSG, {
          current,
          allowed: [...CORRECTABLE_FROM],
        });
      }

      const newId = crypto.randomUUID();
      const now = new Date().toISOString();

      db.exec("BEGIN IMMEDIATE");
      try {
        insert.run(
          newId,
          requestId,
          old.recognition_id,
          old.image_id,
          old.source,
          JSON.stringify(data),
          JSON.stringify(sanitizeFieldMeta(fieldMeta)),
          hash,
          old.client_info,
          now,
          deviceId,
          sessionId,
        );
        lifecycle.transition(
          {
            receiptId: newId,
            to: "corrected",
            event: "receipt.corrected",
            actorKind: "operator",
            deviceId,
            sessionId,
            detail: { supersedesReceiptId: oldReceiptId, reason },
            patch: { supersedes: oldReceiptId },
          },
          { inTransaction: true },
        );
        lifecycle.transition(
          {
            receiptId: oldReceiptId,
            to: "superseded",
            event: "receipt.superseded",
            actorKind: "operator",
            deviceId,
            sessionId,
            detail: { supersededByReceiptId: newId, reason },
            patch: { superseded_by: newId },
            expectFrom: CORRECTABLE_FROM,
          },
          { inTransaction: true },
        );
        outbox.removeFor(oldReceiptId, "post");
        if (sapEnabled()) outbox.enqueue({ receiptId: newId, kind: "post", nowIso: now });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        /* Hai request cùng requestId chạy sát nhau: unique constraint bắt được; đọc lại và
         * xử đúng như nhánh idempotent phía trên. */
        if (isUniqueViolation(err)) {
          const raced = selectByRequest.get(requestId);
          if (raced) return this.resolveExistingCorrection(raced, { oldReceiptId, hash, old });
          throw new ReceiptError(409, "REQUEST_ID_CONFLICT", "requestId này đã được lưu với nội dung khác", {
            receiptId: null,
          });
        }
        throw err;
      }
      logger?.info("receipt.corrected", { receiptId: newId, supersedes: oldReceiptId });
      return {
        receipt: toPublic(selectById.get(newId)),
        oldReceipt: toPublic(selectById.get(oldReceiptId)),
        created: true,
      };
    },

    /* requestId đã có chủ. Cùng phiếu gốc + cùng nội dung → chính lần sửa này đã thành công:
     * trả lại phiếu đã tạo. Khác một trong hai → requestId bị dùng cho việc khác (Q24). */
    resolveExistingCorrection(row, { oldReceiptId, hash, old }) {
      if (row.supersedes === oldReceiptId && row.payload_hash === hash) {
        logger?.info("receipt.correction_idempotent", { receiptId: row.id, requestId: row.request_id, supersedes: oldReceiptId });
        return { receipt: toPublic(row), oldReceipt: toPublic(selectById.get(oldReceiptId) ?? old), created: false };
      }
      throw new ReceiptError(409, "REQUEST_ID_CONFLICT", "requestId này đã được lưu với nội dung khác", {
        receiptId: row.id,
      });
    },
  };
}
