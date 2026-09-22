/* Hợp đồng với SAP. Adapter KHÔNG lưu gì, KHÔNG đổi trạng thái phiếu, KHÔNG ghi receipt_events —
 * nó chỉ gọi đi và trả về, hoặc ném đúng một trong hai lớp lỗi dưới đây.
 *
 * Quy tắc vàng: adapter không bao giờ ném Error trần. Phân loại lỗi là quyết định nghiệp vụ,
 * và worker không có cách nào đoán đúng nếu adapter không nói. */

import { createSapMock } from "./mock.js";

/** Lỗi NGHIỆP VỤ: dữ liệu sai, gửi lại y hệt cũng hỏng y hệt → rejected, KHÔNG retry. */
export class SapBusinessError extends Error {
  /** @param {"SAP_PART_UNKNOWN"|"SAP_LOCATION_LOCKED"|"SAP_QTY_EXCEEDS_PO"|"SAP_DUPLICATE_DOCUMENT"} code */
  constructor(code, message, { sapMessage } = {}) {
    super(message);
    this.name = "SapBusinessError";
    this.code = code;
    this.sapMessage = sapMessage ?? null;
    this.retryable = false;
  }
}

/** Lỗi KỸ THUẬT: hạ tầng, gửi lại có thể được → retry theo backoff, hết lượt thì post_failed. */
export class SapTechnicalError extends Error {
  /** @param {"SAP_UNAVAILABLE"|"SAP_TIMEOUT"|"SAP_AUTH_FAILED"} code */
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "SapTechnicalError";
    this.code = code;
    this.status = status;
    this.retryable = true;
  }
}

/**
 * @typedef {Object} GoodsReceiptPayload
 * @property {string}      receiptId    UUID do BE sinh. ĐÂY LÀ KHOÁ IDEMPOTENCY phía SAP.
 * @property {string}      createdAt
 * @property {string|null} deviceId
 * @property {string|null} sessionId
 * @property {string|null} warehouse    từ sessions.warehouse
 * @property {string|null} operator     từ sessions.operator
 * @property {object}      data         ĐÚNG 13 key
 */

/**
 * @typedef {Object} SapAdapter
 * @property {string} name
 * @property {(p: GoodsReceiptPayload, o?: {signal?: AbortSignal}) => Promise<{sapDocumentNo: string, postedAt: string}>} postGoodsReceipt
 * @property {(p: {receiptId: string, sapDocumentNo: string}, o?: {signal?: AbortSignal}) => Promise<{reversalDocumentNo: string, postedAt: string}>} reverseGoodsReceipt
 */

/** Chọn adapter theo config.sap.adapter. "none" → null (worker không khởi động). */
export function selectSapAdapter({ config, sim, logger } = {}) {
  if (config?.sap?.adapter === "none") return null;
  return createSapMock({ config, sim, logger });
}
