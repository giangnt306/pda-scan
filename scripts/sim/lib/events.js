/* BẢN CHÉP bảng đăng ký loại sự kiện — docs/specs/phase-5/02-contracts-api.md §4.3.
 *
 * Đây là bản chép có chủ ý (S2: scripts/sim không import gì từ mã nguồn ứng dụng). Nhiệm vụ của nó là
 * BẮT LỖI KHI HAI BÊN LỆCH NHAU, nên KHÔNG được tự thêm loại mới: thêm ở đây mà BE không ghi
 * thì kịch bản sẽ chờ một sự kiện không bao giờ tới; thiếu ở đây thì kịch bản không gọi tên
 * được sự kiện có thật.
 *
 * 16 loại cố định + 15 loại receipt.* = 31.
 */

export const FIXED_EVENT_TYPES = [
  "server.start",
  "server.stop",
  "sim.updated",
  "sim.cleared",
  "device.registered",
  "device.camera_error",
  "device.battery_low",
  "device.queue_enqueued",
  "device.queue_synced",
  "device.sim_changed",
  "session.started",
  "session.ended",
  "recognition.started",
  "recognition.completed",
  "recognition.failed",
  "recognition.rejected_busy",
];

/* Đúng 15 tên vòng đời phiếu của phase-4/01-contracts-api.md §3.1, được gương sang
 * system_events với nguyên tiền tố "receipt." (§4.4). */
export const RECEIPT_EVENT_TYPES = [
  "receipt.confirmed",
  "receipt.duplicate_override",
  "receipt.posting",
  "receipt.posted",
  "receipt.post_retry",
  "receipt.post_failed",
  "receipt.rejected",
  "receipt.retry_requested",
  "receipt.cancelled",
  "receipt.reversal_queued",
  "receipt.reversal_posted",
  "receipt.reversal_failed",
  "receipt.corrected",
  "receipt.superseded",
  "receipt.swept",
];

export const EVENT_TYPES = [...FIXED_EVENT_TYPES, ...RECEIPT_EVENT_TYPES];

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

export const isKnownEventType = (type) => EVENT_TYPE_SET.has(type);

/* Loại sự kiện PDA được phép tự gửi lên (02-contracts-api.md §4.5). Thiết bị ảo không gửi
 * sự kiện nào ở Stage 1, nhưng kịch bản có quyền kiểm đếm chúng nên danh sách phải có mặt. */
export const CLIENT_EVENT_TYPES = [
  "device.camera_error",
  "device.battery_low",
  "device.queue_enqueued",
  "device.queue_synced",
  "device.sim_changed",
];
