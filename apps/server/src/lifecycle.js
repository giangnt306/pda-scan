/* Vòng đời phiếu. Đây là module DUY NHẤT được phép ghi receipts.status và receipt_events.
 * Không nơi nào khác trong BE chạy `UPDATE receipts SET status = …`.
 *
 * receipt_events là sổ kiểm toán CHỈ-INSERT: không UPDATE, không DELETE, không bao giờ.
 * Mỗi lần đổi trạng thái ghi ĐÚNG MỘT dòng, trong CÙNG transaction với UPDATE. */

export const RECEIPT_STATUSES = [
  "confirmed",
  "posting",
  "posted",
  "post_failed",
  "rejected",
  "cancelled",
  "corrected",
  "superseded",
];

export const ACTOR_KINDS = ["device", "system", "operator"];

/** Bảng chuyển trạng thái hợp lệ. Khoá = from, giá trị = Set các to hợp lệ. */
export const ALLOWED_TRANSITIONS = {
  confirmed: new Set(["posting", "cancelled", "superseded"]),
  posting: new Set(["posting", "posted", "post_failed", "rejected", "cancelled", "superseded"]),
  posted: new Set(["cancelled"]),
  post_failed: new Set(["posting", "cancelled", "superseded"]),
  rejected: new Set(["cancelled", "superseded"]),
  cancelled: new Set(["cancelled"]), // chỉ để ghi sự kiện reversal, không đổi state
  corrected: new Set(["posting", "cancelled", "superseded"]),
  superseded: new Set([]),
};

/* Trạng thái đầu đời: dòng receipts vừa INSERT còn status = NULL. "bất kỳ → confirmed" bị cấm
 * (§2.1), nên confirmed/corrected chỉ vào được qua đúng con đường này. */
export const INITIAL_TRANSITIONS = new Set(["confirmed", "corrected"]);

/* Cột receipts mà transition() được phép ghi kèm. Danh sách trắng, không nối chuỗi tự do. */
const PATCHABLE_COLUMNS = new Set([
  "sap_document_no",
  "reject_code",
  "sap_message",
  "cancel_reason",
  "supersedes",
  "superseded_by",
  "post_attempts",
]);

export class LifecycleError extends Error {
  constructor(from, to) {
    super(`Không chuyển được phiếu từ "${from}" sang "${to}"`);
    this.name = "LifecycleError";
    this.code = "ILLEGAL_TRANSITION";
    this.from = from;
    this.to = to;
  }
}

/* events/config là THAM SỐ TUỲ CHỌN, mặc định null. Khi events === null thì không ghi gương
 * một dòng nào — đó là mặc định của mọi test Phase 4 hiện có, nên chúng không đổi một ký tự. */
export function createLifecycle({ db, logger, events = null, config = null } = {}) {
  const selectStatus = db.prepare("SELECT status FROM receipts WHERE id = ?");
  const insertEvent = db.prepare(
    `INSERT INTO receipt_events (receipt_id, at, from_state, to_state, event, actor_kind, device_id, session_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectEvents = db.prepare("SELECT * FROM receipt_events WHERE receipt_id = ? ORDER BY id ASC");

  const eventToPublic = (row) => {
    let detail = {};
    try {
      const parsed = JSON.parse(row.detail);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed;
    } catch {
      /* dòng hỏng trong sổ kiểm toán không được làm hỏng cả timeline */
    }
    return {
      id: row.id,
      receiptId: row.receipt_id,
      at: row.at,
      from: row.from_state ?? null,
      to: row.to_state,
      event: row.event,
      actor: { kind: row.actor_kind, deviceId: row.device_id ?? null, sessionId: row.session_id ?? null },
      detail,
    };
  };

  /* Đọc status TRONG transaction rồi mới quyết định — đọc trước khi BEGIN là mời race. */
  function currentStatus(receiptId) {
    const row = selectStatus.get(receiptId);
    if (!row) return undefined; // phiếu không tồn tại
    return row.status ?? null; // null = vừa INSERT, chưa có trạng thái
  }

  function applyPatch(receiptId, to, patch) {
    const sets = ["status = ?"];
    const args = [to];
    for (const [col, value] of Object.entries(patch || {})) {
      if (!PATCHABLE_COLUMNS.has(col)) throw new Error(`Cột "${col}" không được phép ghi qua lifecycle.transition`);
      sets.push(`${col} = ?`);
      args.push(value === undefined ? null : value);
    }
    args.push(receiptId);
    db.prepare(`UPDATE receipts SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  function writeEvent({ receiptId, from, to, event, actorKind, deviceId, sessionId, detail }) {
    if (!ACTOR_KINDS.includes(actorKind)) throw new Error(`actorKind không hợp lệ: ${actorKind}`);
    const at = new Date().toISOString(); // giờ của SERVER, không bao giờ lấy giờ của PDA
    const info = insertEvent.run(
      receiptId,
      at,
      from,
      to,
      event,
      actorKind,
      deviceId ?? null,
      sessionId ?? null,
      JSON.stringify(detail && typeof detail === "object" ? detail : {}),
    );
    /* Ghi gương sang system_events (QUYẾT ĐỊNH A-8): một chuỗi id duy nhất cho cả dòng sự kiện
     * nên `since` không bao giờ bỏ sót dòng. `severity` KHÔNG truyền tay ở đây — events.write
     * tự suy từ EVENT_TYPES, để bảng đăng ký là nguồn sự thật duy nhất (L5-3).
     * try/catch thêm một lớp nữa: lỗi ghi gương TUYỆT ĐỐI không được rollback transaction
     * phiếu đang mở (L5-2). */
    if (events && config?.events?.mirrorReceipts !== false) {
      try {
        events.write({ type: event, deviceId, sessionId, receiptId, detail, at });
      } catch (err) {
        // Tên sự kiện lạ (không có trong EVENT_TYPES) rơi vào đây — cảnh báo để thấy được (L5-4).
        logger?.warn("events.mirror_failed", { event, receiptId, error: err?.message });
      }
    }
    return Number(info.lastInsertRowid);
  }

  /* Bọc một thao tác trong BEGIN IMMEDIATE / COMMIT / ROLLBACK. node:sqlite không có
   * db.transaction() như better-sqlite3, và transaction KHÔNG lồng nhau được — nên nơi gọi
   * đã mở transaction sẵn truyền { inTransaction: true }. */
  function inTx(inTransaction, fn) {
    if (inTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return {
    /**
     * Chuyển trạng thái + ghi ĐÚNG MỘT dòng receipt_events, trong CÙNG MỘT transaction.
     * @returns {{ from: string|null, to: string, eventId: number }}
     * @throws {LifecycleError} chuyển trạng thái không hợp lệ, hoặc expectFrom không khớp
     * @throws {Error} receiptId không tồn tại
     */
    transition(
      { receiptId, to, event, actorKind, deviceId = null, sessionId = null, detail = {}, patch = null, expectFrom = null },
      { inTransaction = false } = {},
    ) {
      return inTx(inTransaction, () => {
        const from = currentStatus(receiptId);
        if (from === undefined) throw new Error(`Không có phiếu ${receiptId}`);
        if (expectFrom && !expectFrom.includes(from)) throw new LifecycleError(from, to);
        const allowed = from === null ? INITIAL_TRANSITIONS.has(to) : (ALLOWED_TRANSITIONS[from]?.has(to) ?? false);
        if (!allowed) throw new LifecycleError(from, to);

        applyPatch(receiptId, to, patch);
        const eventId = writeEvent({ receiptId, from, to, event, actorKind, deviceId, sessionId, detail });
        logger?.info("receipt.transition", { receiptId, from, to, event });
        return { from, to, eventId };
      });
    },

    /** Ghi một dòng receipt_events KHÔNG đổi trạng thái (to = from). Dùng cho
     *  duplicate_override, reversal_queued/posted/failed, swept. */
    note(
      { receiptId, event, actorKind, deviceId = null, sessionId = null, detail = {} },
      { inTransaction = false } = {},
    ) {
      return inTx(inTransaction, () => {
        const state = currentStatus(receiptId);
        if (state === undefined) throw new Error(`Không có phiếu ${receiptId}`);
        const from = state ?? "confirmed";
        const eventId = writeEvent({ receiptId, from, to: from, event, actorKind, deviceId, sessionId, detail });
        return { from, to: from, eventId };
      });
    },

    /** Timeline theo thứ tự cũ-nhất-trước. Phiếu chưa có sự kiện nào → mảng rỗng. */
    events(receiptId) {
      return selectEvents.all(receiptId).map(eventToPublic);
    },

    /** Trạng thái hiện tại, hoặc null nếu phiếu không tồn tại. */
    statusOf(receiptId) {
      const state = currentStatus(receiptId);
      if (state === undefined) return null;
      return state ?? "confirmed";
    },
  };
}
