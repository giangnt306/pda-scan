/* Sổ sự kiện toàn hệ thống (`system_events`) — nền của màn hình giám sát S9.
 *
 * Khác `receipt_events` của Phase 4 ở ba điểm:
 *  1. Ghi MỌI thứ đáng quan sát, không chỉ vòng đời phiếu.
 *  2. Đọc được theo con trỏ `since` tăng dần đơn điệu (điều kiện để nâng lên SSE ở Phase 6).
 *  3. Có VÒNG XOAY: quá `EVENTS_MAX_ROWS` thì cắt bớt dòng cũ. `receipt_events` thì ngược lại —
 *     là sổ kiểm toán CHỈ-INSERT vĩnh viễn, không bao giờ bị đụng tới ở đây.
 *
 * Nguyên tắc sống còn: sổ quan sát KHÔNG BAO GIỜ được làm chết một request nghiệp vụ.
 * Lỗi DB lúc ghi bị nuốt và chỉ ghi logger.warn. Ngoại lệ DUY NHẤT là `type` sai — đó là lỗi
 * lập trình, ghi im lặng sẽ giấu bug tới tận lúc demo (E1). */

/** Bảng đăng ký loại sự kiện — chép nguyên văn `docs/specs/phase-5/02-contracts-api.md` §4.3.
 *  16 loại cố định + 15 loại `receipt.*` = 31. */
export const EVENT_TYPES = Object.freeze({
  "server.start": "info",
  "server.stop": "info",
  "sim.updated": "warn",
  "sim.cleared": "info",
  "device.registered": "info",
  "device.camera_error": "warn",
  "device.battery_low": "warn",
  "device.queue_enqueued": "warn",
  "device.queue_synced": "info",
  "device.sim_changed": "warn",
  "session.started": "info",
  "session.ended": "info",
  "recognition.started": "info",
  "recognition.completed": "info",
  "recognition.failed": "error",
  "recognition.rejected_busy": "warn",
  /* 15 tên của phase-4/01-contracts-api.md §3.1. Severity theo §4.4 của hợp đồng Phase 5. */
  "receipt.confirmed": "info",
  "receipt.duplicate_override": "warn",
  "receipt.posting": "info",
  "receipt.posted": "info",
  "receipt.post_retry": "warn",
  "receipt.post_failed": "error",
  "receipt.rejected": "error",
  "receipt.retry_requested": "info",
  "receipt.cancelled": "info",
  "receipt.reversal_queued": "info",
  "receipt.reversal_posted": "info",
  "receipt.reversal_failed": "error",
  "receipt.corrected": "info",
  "receipt.superseded": "info",
  "receipt.swept": "warn",
});

export const SEVERITIES = Object.freeze(["info", "warn", "error"]);

/* 5 loại PDA được phép tự gửi lên qua POST /api/devices/:id/events.
 * KHÔNG có session.started: BE đã tự ghi nó ở POST /api/sessions/start, để PDA gửi thêm sẽ
 * thành hai dòng cho cùng một việc. */
export const CLIENT_EVENT_TYPES = Object.freeze([
  "device.camera_error",
  "device.battery_low",
  "device.queue_enqueued",
  "device.queue_synced",
  "device.sim_changed",
]);

export const DETAIL_MAX_BYTES = 2048;

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/* detail không phải object → {}. JSON hoá vượt trần → { _truncated: true } (E5).
 * Cắt giữa chừng thì JSON không parse lại được, nên thay hẳn chứ không cắt. */
export function normalizeDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "{}";
  let json;
  try {
    json = JSON.stringify(detail);
  } catch {
    return "{}"; // vòng tham chiếu
  }
  if (typeof json !== "string") return "{}";
  if (Buffer.byteLength(json) > DETAIL_MAX_BYTES) return JSON.stringify({ _truncated: true });
  return json;
}

function parseDetail(raw) {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const toPublic = (row) => ({
  id: row.id,
  at: row.at,
  type: row.type,
  severity: row.severity,
  deviceId: row.device_id ?? null,
  sessionId: row.session_id ?? null,
  receiptId: row.receipt_id ?? null,
  recognitionId: row.recognition_id ?? null,
  clientAt: row.client_at ?? null,
  detail: parseDetail(row.detail),
});

export function createEventLog({ db, config, logger } = {}) {
  const enabled = config?.events?.enabled !== false;
  const maxRows = Number(config?.events?.maxRows ?? 2000);
  const trimEvery = Math.max(1, Number(config?.events?.trimEvery ?? 100));

  const insert = db.prepare(
    `INSERT INTO system_events (at, type, severity, device_id, session_id, receipt_id, recognition_id, client_at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM system_events");
  /* `id` nhỏ nhất CÒN GIỮ được. Đây là thứ duy nhất cho phép người đọc biết vòng xoay đã cắt
   * qua con trỏ `since` của mình hay chưa: thiếu nó thì các dòng bị cắt biến mất IM LẶNG và
   * màn hình giám sát vẫn vẽ dòng sự kiện như thể liền mạch (F-11). Rẻ: MIN trên khoá chính. */
  const oldestStmt = db.prepare("SELECT MIN(id) AS lo FROM system_events");
  /* Vòng xoay: giữ maxRows dòng mới nhất. Dựa trên MAX(id) chứ không trên COUNT(*) để một
   * lần cắt là một câu lệnh, không phải một lần quét cả bảng. */
  const trimStmt = db.prepare(
    "DELETE FROM system_events WHERE id <= (SELECT MAX(id) FROM system_events) - ?",
  );

  let writes = 0;

  /* `at` tuỳ chọn: nơi gọi trong BE (lifecycle) đã sinh sẵn giờ SERVER và muốn hai dòng
   * receipt_events / system_events mang đúng cùng mốc. KHÔNG BAO GIỜ nhận giờ của PDA ở đây —
   * giờ client đi vào cột client_at. */
  function prepareRow({ type, severity, deviceId, sessionId, receiptId, recognitionId, clientAt, detail, at }) {
    if (!Object.hasOwn(EVENT_TYPES, type)) {
      throw new Error(`Loại sự kiện không có trong EVENT_TYPES: ${String(type)}`);
    }
    const sev = severity ?? EVENT_TYPES[type];
    if (!SEVERITIES.includes(sev)) throw new Error(`severity không hợp lệ: ${String(severity)}`);
    return [
      typeof at === "string" && ISO_LIKE.test(at) ? at : new Date().toISOString(),
      type,
      sev,
      deviceId ?? null,
      sessionId ?? null,
      receiptId ?? null,
      recognitionId ?? null,
      typeof clientAt === "string" && ISO_LIKE.test(clientAt) ? clientAt : null,
      normalizeDetail(detail),
    ];
  }

  /* Đếm theo SỐ DÒNG đã ghi (không phải số lần gọi): một lô 20 dòng của PDA phải làm vòng xoay
   * tiến đúng 20 bước, nếu không bảng sẽ phình quá EVENTS_MAX_ROWS mà không ai cắt. */
  function afterWrite() {
    writes += 1;
    if (writes % trimEvery === 0) trimStmt.run(maxRows);
  }

  function buildFilter({ types, severity, deviceId }) {
    const where = [];
    const args = [];
    if (Array.isArray(types) && types.length > 0) {
      where.push(`type IN (${types.map(() => "?").join(", ")})`);
      args.push(...types);
    }
    if (SEVERITIES.includes(severity)) {
      where.push("severity = ?");
      args.push(severity);
    }
    if (typeof deviceId === "string" && deviceId) {
      where.push("device_id = ?");
      args.push(deviceId);
    }
    return { where, args };
  }

  return {
    enabled,

    /** Ghi MỘT sự kiện. Ném Error nếu `type` ngoài EVENT_TYPES hoặc `severity` lạ.
     *  KHÔNG BAO GIỜ ném vì lỗi DB. Trả id dòng vừa ghi, hoặc null. */
    write(event = {}) {
      const row = prepareRow(event); // E1/E2: ném TRƯỚC khi xét enabled — bug phải lộ ra
      if (!enabled) return null;
      try {
        const info = insert.run(...row);
        afterWrite();
        return Number(info.lastInsertRowid);
      } catch (err) {
        logger?.warn("events.write_failed", { type: event?.type, error: err?.message });
        return null;
      }
    },

    /** Ghi nhiều sự kiện trong MỘT transaction. Trả số dòng đã ghi. */
    writeMany(list = []) {
      const rows = list.map((e) => prepareRow(e)); // validate CẢ LÔ trước khi mở transaction
      if (!enabled || rows.length === 0) return 0;
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows) {
            insert.run(...row);
            afterWrite();
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return rows.length;
      } catch (err) {
        logger?.warn("events.write_failed", { count: rows.length, error: err?.message });
        return 0;
      }
    },

    /**
     * §4.6 của hợp đồng. LUÔN trả thứ tự id TĂNG DẦN.
     * `since === 0` nghĩa là "cho tôi `limit` dòng MỚI NHẤT" (QUYẾT ĐỊNH A-11) — hai nhánh
     * dùng HAI câu SQL khác nhau, đây là chỗ dễ làm sai nhất của cả Phase 5.
     *
     * Trả kèm `oldestId` = MIN(id) của CẢ BẢNG (xem `oldestStmt`). Client so `since` với nó để
     * biết vòng xoay đã cắt qua con trỏ của mình chưa. `0` nghĩa là "bảng rỗng HOẶC không đọc
     * được" — hai trường hợp này KHÔNG cho phép kết luận là đã mất dòng.
     */
    list({ since = 0, limit = 50, types = null, severity = null, deviceId = null } = {}) {
      const cursor = Number.isInteger(since) && since > 0 ? since : 0;
      const n = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 50));
      if (!enabled) return { items: [], lastId: cursor, hasMore: false, oldestId: 0 };

      const { where, args } = buildFilter({ types, severity, deviceId });
      let rows;
      try {
        if (cursor === 0) {
          const inner = `SELECT * FROM system_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
          rows = db.prepare(`SELECT * FROM (${inner}) ORDER BY id ASC`).all(...args, n);
        } else {
          const clauses = ["id > ?", ...where];
          rows = db
            .prepare(`SELECT * FROM system_events WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`)
            .all(cursor, ...args, n);
        }
      } catch (err) {
        logger?.warn("events.list_failed", { error: err?.message });
        return { items: [], lastId: cursor, hasMore: false, oldestId: 0 };
      }

      const items = rows.map(toPublic);
      /* E8: items rỗng → lastId BẰNG since client gửi, không phải 0. Trả 0 sẽ làm monitor
       * tải lại dòng sự kiện từ đầu mỗi 3 giây. */
      const lastId = items.length ? items[items.length - 1].id : cursor;
      let hasMore = false;
      try {
        const clauses = ["id > ?", ...where];
        // E9: một SELECT EXISTS, không đếm toàn bảng.
        hasMore =
          db.prepare(`SELECT EXISTS(SELECT 1 FROM system_events WHERE ${clauses.join(" AND ")}) AS more`).get(lastId, ...args)
            .more === 1;
      } catch (err) {
        logger?.warn("events.list_failed", { error: err?.message });
      }

      /* CỐ Ý không áp bộ lọc vào câu MIN này: vòng xoay cắt theo BẢNG, không theo bộ lọc.
       * MIN của tập đã lọc chỉ nói "dòng khớp lọc cũ nhất còn lại", không trả lời được câu
       * "con trỏ của tôi có bị cắt qua không" — và trả lời sai còn tệ hơn không trả lời. */
      let oldestId = 0;
      try {
        const lo = oldestStmt.get()?.lo;
        oldestId = Number.isFinite(Number(lo)) ? Number(lo) : 0;
      } catch (err) {
        logger?.warn("events.list_failed", { error: err?.message });
      }
      return { items, lastId, hasMore, oldestId };
    },

    /** Số dòng hiện có (cho test và cho kiểm vòng xoay). */
    count() {
      try {
        return countStmt.get().n;
      } catch {
        return 0;
      }
    },

    /** Số dòng đã ghi kể từ khi tiến trình lên (cho test vòng xoay). */
    writeCount() {
      return writes;
    },
  };
}
