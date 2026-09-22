/* Quy tắc nghiệp vụ v1 chạy TRƯỚC khi lưu phiếu.
 *
 * Thứ tự cố định (Q31): vị trí trước, trùng nhãn sau.
 * Idempotency đã được receipts.create() xử lý TRƯỚC khi gọi vào đây (Q30) — không rule nào được
 * phép nhìn thấy một lần retry cùng requestId và gọi nó là trùng nhãn.
 */
import { ReceiptError } from "../receipts.js";
import { checkLocation } from "./location.js";
import { findDuplicate } from "./duplicate.js";

/**
 * @param {object} deps  { db, config, master, logger }
 * @returns {{
 *   checkBeforeCreate: (input: {
 *     data: object,          // 13 trường ĐÃ qua validateReceiptData
 *     sessionId: string|null,
 *     deviceId: string|null,
 *     allowDuplicate: boolean,
 *     nowIso: string,
 *   }) => { duplicateOf: null | { receiptId, createdAt, deviceId, status, key } },
 *   checkLocationOnly: (data: object) => void
 * }}
 * @throws {ReceiptError} 422 LOCATION_UNKNOWN | 409 DUPLICATE_LABEL
 */
export function createRules({ db, config, master, logger } = {}) {
  return {
    checkBeforeCreate({ data, sessionId, deviceId, allowDuplicate, nowIso }) {
      checkLocation({ data, config, master }); // ⭐ vị trí TRƯỚC (Q31)
      if (config?.rules?.duplicate !== true) return { duplicateOf: null };

      const dup = findDuplicate({ db, data, sessionId, nowIso, tzOffsetMinutes: config?.tzOffsetMinutes ?? 420 });
      if (!dup) return { duplicateOf: null };

      /* Người vận hành đã xem cảnh báo và quyết định vẫn lưu: không ném, trả phiếu cũ về để
       * receipts.create() ghi sự kiện receipt.duplicate_override trong cùng transaction. */
      if (allowDuplicate === true) {
        logger?.info("receipt.duplicate_override", { existingReceiptId: dup.receiptId, deviceId: deviceId ?? null });
        return { duplicateOf: dup };
      }

      throw new ReceiptError(409, "DUPLICATE_LABEL", "Nhãn này đã được nhập hôm nay", {
        existingReceiptId: dup.receiptId,
        existingCreatedAt: dup.createdAt,
        existingDeviceId: dup.deviceId,
        existingStatus: dup.status,
        key: dup.key,
      });
    },

    /** Chỉ dùng cho POST …/correct — bỏ qua rule trùng nhãn (Q25): phiếu sửa gần như chắc chắn
     *  trùng nhãn với chính phiếu mà nó thay thế. Rule vị trí thì VẪN áp dụng. */
    checkLocationOnly(data) {
      checkLocation({ data, config, master });
    },
  };
}
