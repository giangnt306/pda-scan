import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* Schema Phase 1. Ba bảng, không ORM.
 * - images: file ảnh do BE quản lý (tên file do server tạo).
 * - recognitions: một lần gọi nhận dạng trên một ảnh. Giữ raw_result (provider trả gì)
 *   tách khỏi normalized (đã ánh xạ về schema form). Trạng thái để sau mở rộng job/polling.
 * - receipts: bản ghi chính thức người dùng đã xác nhận. request_id UNIQUE chống ghi trùng.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  file_name   TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recognitions (
  id            TEXT PRIMARY KEY,
  image_id      TEXT NOT NULL REFERENCES images(id),
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  raw_result    TEXT,
  normalized    TEXT,
  error_code    TEXT,
  error_message TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS receipts (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL UNIQUE,
  recognition_id  TEXT REFERENCES recognitions(id),
  image_id        TEXT REFERENCES images(id),
  source          TEXT NOT NULL CHECK (source IN ('camera','barcode','manual')),
  data            TEXT NOT NULL,
  field_meta      TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  client_info     TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  app_version  TEXT,
  platform     TEXT,
  last_network TEXT NOT NULL DEFAULT 'unknown',
  screen       TEXT,
  battery      REAL,
  pending_queue INTEGER NOT NULL DEFAULT 0,
  meta         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  operator   TEXT,
  warehouse  TEXT,
  shift      TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  end_reason TEXT
);

CREATE TABLE IF NOT EXISTS sim_state (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS receipt_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  event      TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('device','system','operator')),
  device_id  TEXT,
  session_id TEXT,
  detail     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('post','reversal')),
  state           TEXT NOT NULL CHECK (state IN ('pending','inflight','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

/* Phase 5 - so su kien toan he thong cho man hinh giam sat. Cot "at" LUON la gio server;
   cot "client_at" la gio PDA tu khai, chi de tham khao, KHONG BAO GIO dung de sap xep.
   Chu thich nay co y viet khong dau va khong dung dau huyen nguoc: ca khoi SQL nam trong
   mot template literal, mot dau huyen nguoc lac vao day se cat doi chuoi va lam hong file. */
CREATE TABLE IF NOT EXISTS system_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  type           TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
  device_id      TEXT,
  session_id     TEXT,
  receipt_id     TEXT,
  recognition_id TEXT,
  client_at      TEXT,
  detail         TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_system_events_at   ON system_events(id DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_type ON system_events(type, id DESC);

CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts(created_at);
CREATE INDEX IF NOT EXISTS idx_recognitions_image ON recognitions(image_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id, started_at);
CREATE INDEX IF NOT EXISTS idx_receipt_events_receipt ON receipt_events(receipt_id, id);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(state, next_attempt_at);
/* Một phiếu có tối đa MỘT job 'post' và MỘT job 'reversal' (L1). Ràng buộc đặt ở tầng DB để
 * mọi bug "tạo hai job" thành một exception nhìn thấy được, thay vì hai chứng từ SAP. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_receipt_kind ON outbox(receipt_id, kind);
`;

/* Index trên cột chỉ tồn tại sau migrate() — tách khỏi SCHEMA để thứ tự chạy luôn đúng
 * trên DB cũ (bảng có rồi nhưng chưa có cột). */
const POST_MIGRATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_receipts_device ON receipts(device_id);
CREATE INDEX IF NOT EXISTS idx_receipts_session ON receipts(session_id);
CREATE INDEX IF NOT EXISTS idx_recognitions_session ON recognitions(session_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_receipts_supersedes ON receipts(supersedes);
CREATE INDEX IF NOT EXISTS idx_recognitions_status ON recognitions(status, created_at);
`;

export function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/* SQLite không có ADD COLUMN IF NOT EXISTS: phải tự hỏi PRAGMA trước. Cột thêm vào bảng
 * đã có dữ liệu bắt buộc nullable và không DEFAULT động, nếu không SQLite từ chối. */
function addColumnIfMissing(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/* Chạy mỗi lần openDb(), kể cả trên DB thật đang có dữ liệu. Chỉ thêm, không bao giờ
 * DROP/DELETE/đổi kiểu — dữ liệu cũ phải mở lại được sau khi nâng cấp. */
export function migrate(db, logger) {
  addColumnIfMissing(db, "receipts", "device_id", "TEXT");
  addColumnIfMissing(db, "receipts", "session_id", "TEXT");
  addColumnIfMissing(db, "recognitions", "device_id", "TEXT");
  addColumnIfMissing(db, "recognitions", "session_id", "TEXT");
  addColumnIfMissing(db, "recognitions", "request_id", "TEXT");

  /* Phase 4 — vòng đời phiếu. Tất cả nullable, không DEFAULT động: SQLite từ chối thêm cột
   * NOT NULL/DEFAULT động vào bảng đã có dữ liệu. */
  addColumnIfMissing(db, "receipts", "status", "TEXT");
  addColumnIfMissing(db, "receipts", "sap_document_no", "TEXT");
  addColumnIfMissing(db, "receipts", "reject_code", "TEXT");
  addColumnIfMissing(db, "receipts", "sap_message", "TEXT");
  addColumnIfMissing(db, "receipts", "supersedes", "TEXT");
  addColumnIfMissing(db, "receipts", "superseded_by", "TEXT");
  addColumnIfMissing(db, "receipts", "cancel_reason", "TEXT");
  addColumnIfMissing(db, "receipts", "post_attempts", "INTEGER");

  /* Phase 5 — nhận dạng bất đồng bộ. KHÔNG backfill: NULL ở hai cột này đã có nghĩa rõ ràng
   * ("không biết" = coi như sync, "không có capture_ref"). */
  addColumnIfMissing(db, "recognitions", "mode", "TEXT");
  addColumnIfMissing(db, "recognitions", "capture_ref", "TEXT");

  /* Phiếu lưu trước Phase 4 chưa có trạng thái: coi như đã xác nhận xong. KHÔNG tạo job
   * outbox và KHÔNG ghi receipt_events cho chúng (Q16) — nâng cấp phần mềm không được
   * tự gửi dữ liệu thử nghiệm cũ sang SAP. Chạy lần hai thì changes = 0. */
  const statusFilled = Number(db.prepare("UPDATE receipts SET status = 'confirmed' WHERE status IS NULL").run().changes ?? 0);
  const attemptsFilled = Number(db.prepare("UPDATE receipts SET post_attempts = 0 WHERE post_attempts IS NULL").run().changes ?? 0);
  logger?.info("receipts.backfill", { statusFilled, attemptsFilled });

  db.exec(POST_MIGRATE_INDEXES);
  return db;
}

export function openDb(dbPath, logger) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  migrate(db, logger);
  return db;
}

export const isUniqueViolation = (err) =>
  err?.code === "ERR_SQLITE_ERROR" && (err.errcode === 2067 || /UNIQUE constraint failed/i.test(err.message));
