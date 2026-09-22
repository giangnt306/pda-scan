import crypto from "node:crypto";

/* Phiên làm việc = một ca: device + người vận hành + kho + ca. Một thiết bị chỉ có tối đa
 * một phiên đang mở (Q5); mở phiên mới thì phiên cũ bị đóng với end_reason = "superseded". */

export const SHIFTS = new Set(["sang", "chieu", "dem"]);
export const END_REASONS = new Set(["manual", "timeout", "superseded"]);

const trimOrNull = (v, max = 80) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export function createSessionService({ db, logger }) {
  const insert = db.prepare(
    "INSERT INTO sessions (id, device_id, operator, warehouse, shift, started_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectOne = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const selectActive = db.prepare(
    "SELECT * FROM sessions WHERE device_id = ? AND ended_at IS NULL ORDER BY started_at DESC",
  );
  const endStmt = db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL");
  const countReceipts = db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE session_id = ?");
  const countRecognitions = db.prepare("SELECT COUNT(*) AS n FROM recognitions WHERE session_id = ?");
  const countRecognitionsFailed = db.prepare(
    "SELECT COUNT(*) AS n FROM recognitions WHERE session_id = ? AND status = 'failed'",
  );

  function summary(sessionId) {
    return {
      receipts: countReceipts.get(sessionId).n,
      recognitions: countRecognitions.get(sessionId).n,
      recognitionsFailed: countRecognitionsFailed.get(sessionId).n,
    };
  }

  const toPublic = (row) => ({
    id: row.id,
    deviceId: row.device_id,
    operator: row.operator ?? null,
    warehouse: row.warehouse ?? null,
    shift: row.shift ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    endReason: row.end_reason ?? null,
    summary: summary(row.id),
  });

  return {
    summary,

    start({ deviceId, operator, warehouse, shift } = {}) {
      const now = new Date().toISOString();
      // Đóng phiên đang mở trước: người vận hành đổi ca mà quên bấm "kết thúc" là chuyện thường.
      const open = selectActive.all(deviceId);
      let supersededSessionId = null;
      for (const row of open) {
        endStmt.run(now, "superseded", row.id);
        supersededSessionId = supersededSessionId ?? row.id;
      }
      const id = crypto.randomUUID();
      insert.run(id, deviceId, trimOrNull(operator), trimOrNull(warehouse), shift ?? null, now);
      logger?.info("session.started", { sessionId: id, deviceId, supersededSessionId });
      return { session: toPublic(selectOne.get(id)), supersededSessionId };
    },

    /* Idempotent: đóng lại phiên đã đóng không đổi endedAt/endReason (FE có thể retry). */
    end(sessionId, reason = "manual") {
      const row = selectOne.get(sessionId);
      if (!row) return null;
      if (row.ended_at) return { session: toPublic(row), alreadyEnded: true };
      endStmt.run(new Date().toISOString(), END_REASONS.has(reason) ? reason : "manual", sessionId);
      logger?.info("session.ended", { sessionId, reason });
      return { session: toPublic(selectOne.get(sessionId)), alreadyEnded: false };
    },

    get(sessionId) {
      const row = selectOne.get(sessionId);
      return row ? toPublic(row) : null;
    },

    activeFor(deviceId) {
      const row = selectActive.all(deviceId)[0];
      return row ? toPublic(row) : null;
    },
  };
}
