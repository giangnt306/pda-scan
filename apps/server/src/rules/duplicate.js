/* Rule "trùng nhãn": cùng partNumber + batch + saNumber + kho + NGÀY ĐỊA PHƯƠNG.
 *
 * QUYẾT ĐỊNH Q32 (bản UTC đã BỊ BÁC). Khoá nghiệp vụ "cùng ngày" đếm theo ngày ĐỊA PHƯƠNG của kho,
 * không phải ngày UTC: kho chạy ở Việt Nam (UTC+7) nên mốc 00:00 UTC rơi vào 07:00 giờ VN — giữa ca
 * sáng. Với ngày UTC, hai phiếu cùng lô cách nhau 10 phút quanh 07:00 sẽ bị coi là "khác ngày" và
 * không ai được cảnh báo, đúng lúc cần cảnh báo nhất.
 *
 * Mọi mốc thời gian LƯU TRỮ vẫn là UTC; chỉ riêng khoá "cùng ngày" đổi sang giờ địa phương.
 *
 * Cách hiện thực: thay vì `substr(created_at, 1, 10) = :day` (ngày UTC) của SQL tham chiếu ở
 * 01-contracts-api.md §9.3, ta so sánh created_at với NỬA KHOẢNG [đầu ngày, đầu ngày hôm sau) đã
 * quy về UTC. So sánh chuỗi ISO-8601 cùng định dạng tương đương so sánh thời gian, nên vẫn là một
 * phép so chuỗi thuần trong SQLite — không phụ thuộc hàm date/time nào của SQLite.
 */

const DAY_MS = 86_400_000;

/** Ngày địa phương ("YYYY-MM-DD") của một mốc UTC. */
export function localDay(iso, tzOffsetMinutes = 420) {
  return new Date(Date.parse(iso) + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Nửa khoảng UTC [from, to) phủ đúng một ngày địa phương. */
export function localDayRangeUtc(iso, tzOffsetMinutes = 420) {
  const day = localDay(iso, tzOffsetMinutes);
  const startMs = Date.parse(`${day}T00:00:00.000Z`) - tzOffsetMinutes * 60_000;
  return { day, fromIso: new Date(startMs).toISOString(), toIso: new Date(startMs + DAY_MS).toISOString() };
}

/* r.status được SELECT thêm so với SQL tham chiếu: chi tiết lỗi 409 cần existingStatus, và
 * phiếu cũ trước Phase 4 có status NULL nên phải COALESCE về 'confirmed'. */
const SQL = `
SELECT r.id, r.created_at, r.device_id, COALESCE(r.status, 'confirmed') AS status
  FROM receipts r
  LEFT JOIN sessions s ON s.id = r.session_id
 WHERE json_extract(r.data, '$.partNumber')            = ?
   AND COALESCE(json_extract(r.data, '$.batch'), '')    = ?
   AND COALESCE(json_extract(r.data, '$.saNumber'), '') = ?
   AND COALESCE(s.warehouse, '')                        = ?
   AND r.created_at                                    >= ?
   AND r.created_at                                     < ?
   AND COALESCE(r.status, 'confirmed') NOT IN ('cancelled', 'superseded')
 ORDER BY r.created_at ASC, r.rowid ASC
 LIMIT 1`;

/* Chuẩn bị câu lệnh MỘT LẦN cho mỗi DB, giống cách các service khác làm lúc khởi tạo — nhưng
 * findDuplicate nhận `db` qua tham số nên phải nhớ theo DB. WeakMap để DB đóng rồi thì cache tan. */
const stmtCache = new WeakMap();
function statements(db) {
  let s = stmtCache.get(db);
  if (!s) {
    s = { find: db.prepare(SQL), warehouse: db.prepare("SELECT warehouse FROM sessions WHERE id = ?") };
    stmtCache.set(db, s);
  }
  return s;
}

/**
 * @param {object} p
 * @param {object} p.db                  chỉ ĐỌC (K2)
 * @param {object} p.data                13 trường ĐÃ qua validateReceiptData
 * @param {string|null} p.sessionId
 * @param {string} p.nowIso              mốc của phiếu đang được tạo
 * @param {number} [p.tzOffsetMinutes]   múi giờ kho, mặc định 420 (UTC+7)
 * @returns {null | { receiptId: string, createdAt: string, deviceId: string|null, status: string, key: object }}
 */
export function findDuplicate({ db, data, sessionId, nowIso, tzOffsetMinutes = 420 }) {
  /* sessions.warehouse là chuỗi tự do do FE gửi (Q26), lấy nguyên văn. Không có phiên → "":
   * phiếu không gắn phiên chỉ trùng với nhau, không trùng với phiếu có phiên (§14 câu 14). */
  const stmt = statements(db);
  const warehouse = sessionId ? (stmt.warehouse.get(sessionId)?.warehouse ?? "") : "";
  const { day, fromIso, toIso } = localDayRangeUtc(nowIso, tzOffsetMinutes);
  const partNumber = data?.partNumber ?? null;
  const batch = data?.batch ?? null;
  const saNumber = data?.saNumber ?? null;

  const row = stmt.find.get(partNumber, batch ?? "", saNumber ?? "", warehouse, fromIso, toIso);
  if (!row) return null;
  return {
    receiptId: row.id,
    createdAt: row.created_at,
    deviceId: row.device_id ?? null,
    status: row.status,
    /* key echo lại giá trị NGHIỆP VỤ (batch/saNumber giữ null) chứ không phải chuỗi rỗng đã
     * dùng để so sánh — FE hiển thị lại đúng cái người vận hành đã nhập. */
    key: { partNumber, batch, saNumber, warehouse, day },
  };
}
