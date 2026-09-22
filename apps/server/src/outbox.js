/* Hàng đợi gửi SAP. Module này chỉ truy cập bảng `outbox` — không có logic nghiệp vụ,
 * không đổi trạng thái phiếu, không ghi receipt_events. Việc đó là của lifecycle. */

const toJob = (row) =>
  row
    ? {
        id: row.id,
        receiptId: row.receipt_id,
        kind: row.kind,
        state: row.state,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

export function createOutbox({ db, config, logger } = {}) {
  /* ON CONFLICT DO NOTHING dựa vào UNIQUE(receipt_id, kind): hai lần enqueue cho cùng một
   * phiếu không bao giờ tạo hai chứng từ SAP. */
  const insert = db.prepare(
    `INSERT INTO outbox (receipt_id, kind, state, attempts, next_attempt_at, last_error, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)
     ON CONFLICT(receipt_id, kind) DO NOTHING`,
  );
  const selectByReceiptKind = db.prepare("SELECT * FROM outbox WHERE receipt_id = ? AND kind = ?");
  const selectById = db.prepare("SELECT * FROM outbox WHERE id = ?");
  const selectForReceipt = db.prepare("SELECT * FROM outbox WHERE receipt_id = ? ORDER BY id ASC");
  const selectDue = db.prepare(
    `SELECT * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, id ASC LIMIT ?`,
  );
  /* state='pending' nằm trong WHERE chứ không chỉ trong code: hai tiến trình cùng nhặt một
   * job thì chỉ một cái thấy changes = 1. */
  const markInflightStmt = db.prepare(
    "UPDATE outbox SET state = 'inflight', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'pending'",
  );
  const rescheduleStmt = db.prepare(
    "UPDATE outbox SET state = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
  );
  const giveUpStmt = db.prepare("UPDATE outbox SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?");
  const requeueStmt = db.prepare(
    `UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE receipt_id = ? AND kind = ?`,
  );
  const removeStmt = db.prepare("DELETE FROM outbox WHERE id = ?");
  const removeForStmt = db.prepare("DELETE FROM outbox WHERE receipt_id = ? AND kind = ?");
  const countPending = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'");
  const selectInflight = db.prepare("SELECT * FROM outbox WHERE state = 'inflight'");
  const resetInflight = db.prepare(
    "UPDATE outbox SET state = 'pending', next_attempt_at = ?, updated_at = ? WHERE state = 'inflight'",
  );

  return {
    /** INSERT job. Nếu đã có (receipt_id, kind) → KHÔNG tạo thêm, trả job cũ. */
    enqueue({ receiptId, kind = "post", nowIso = new Date().toISOString() } = {}) {
      insert.run(receiptId, kind, nowIso, nowIso, nowIso);
      return toJob(selectByReceiptKind.get(receiptId, kind));
    },

    /** Job tới hạn, cũ nhất trước. */
    due(nowIso, limit = 10) {
      return selectDue.all(nowIso, limit).map(toJob);
    },

    /** Đánh dấu đang gọi SAP. Trả null khi job đã bị ai đó nhặt mất (changes = 0). */
    markInflight(id, nowIso = new Date().toISOString()) {
      const info = markInflightStmt.run(nowIso, id);
      if (Number(info.changes ?? 0) === 0) return null;
      return { attempts: selectById.get(id).attempts };
    },

    /** Lên lịch thử lại. */
    reschedule(id, { at, lastError = null, nowIso = new Date().toISOString() } = {}) {
      rescheduleStmt.run(at, lastError, nowIso, id);
      return toJob(selectById.get(id));
    },

    /** Bỏ cuộc: job ở lại bảng để người vận hành bấm "Gửi lại". */
    giveUp(id, { lastError = null, nowIso = new Date().toISOString() } = {}) {
      giveUpStmt.run(lastError, nowIso, id);
      return toJob(selectById.get(id));
    },

    /** Đưa job về đầu hàng đợi cho POST …/retry-post. Job đã bị xoá thì tạo lại. */
    requeue({ receiptId, kind = "post", nowIso = new Date().toISOString() } = {}) {
      insert.run(receiptId, kind, nowIso, nowIso, nowIso);
      requeueStmt.run(nowIso, nowIso, receiptId, kind);
      return toJob(selectByReceiptKind.get(receiptId, kind));
    },

    remove(id) {
      return Number(removeStmt.run(id).changes ?? 0);
    },

    removeFor(receiptId, kind) {
      return Number(removeForStmt.run(receiptId, kind).changes ?? 0);
    },

    /** Đếm cho GET /api/status. state='failed' KHÔNG tính: đã bỏ cuộc, đang chờ người bấm. */
    pendingCount() {
      return countPending.get().n;
    },

    get(id) {
      return toJob(selectById.get(id));
    },

    forReceipt(receiptId) {
      return selectForReceipt.all(receiptId).map(toJob);
    },

    /* Sweep S1 (§6): BE chết giữa lúc gọi SAP để lại job 'inflight' không ai quay lại làm.
     * GIỮ NGUYÊN attempts — reset sẽ làm một BE hay restart retry vô hạn và không bao giờ
     * tới post_failed, che mất đúng cái cần thấy (L6). */
    inflightJobs() {
      return selectInflight.all().map(toJob);
    },

    reviveInflight(nowIso = new Date().toISOString()) {
      const n = Number(resetInflight.run(nowIso, nowIso).changes ?? 0);
      if (n > 0) logger?.info("outbox.revived", { count: n });
      return n;
    },

    get backoffsMs() {
      return config?.outbox?.backoffsMs ?? [];
    },
  };
}
