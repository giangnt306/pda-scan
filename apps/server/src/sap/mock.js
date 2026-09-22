/* SAP giả lập, 4 mode lấy từ scenario engine. Mode đọc lại Ở MỖI LẦN GỌI (không cache) để
 * bật/tắt kịch bản có hiệu lực ngay với job kế tiếp.
 *
 * L9: mock chỉ nghe kịch bản TOÀN CỤC. SAP nằm ở đầu kia của Main Backend, nó không biết phiếu
 * đến từ PDA nào — kịch bản theo thiết bị chỉ có nghĩa cho backend/ocr/save. */

import { SapBusinessError, SapTechnicalError } from "./adapter.js";

/* sleep phải tôn trọng signal, nếu không SAP_TIMEOUT_MS thành vô nghĩa với mode slow. */
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timedOut = () => reject(new SapTechnicalError("SAP_TIMEOUT", "SAP phản hồi quá lâu"));
    if (signal?.aborted) return timedOut();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        timedOut();
      },
      { once: true },
    );
  });

const docNo = (prefix, seq) => prefix + String(seq).padStart(6, "0");

export function createSapMock({ config, sim, logger } = {}) {
  /* L10: map trong RAM là bắt buộc — không có nó thì test idempotency xanh giả, vì mỗi lần gọi
   * lại sinh số chứng từ mới mà chẳng ai phát hiện. Mất khi restart BE: chấp nhận với mock. */
  const issued = new Map(); // receiptId → { sapDocumentNo, postedAt }
  const reversed = new Map(); // receiptId → { reversalDocumentNo, postedAt }
  let seq = 0;
  let reversalSeq = 0;

  const scenario = () => {
    const sap = sim?.effective({ deviceId: null })?.sap;
    return { mode: sap?.mode ?? "success", latencyMs: Number(sap?.latencyMs) || 0 };
  };

  const successDelay = (mode, latencyMs) =>
    (mode === "slow" ? (config?.sap?.mockSlowDelayMs ?? 8000) : (config?.sap?.mockSuccessDelayMs ?? 300)) + latencyMs;

  return {
    name: "mock",

    async postGoodsReceipt(payload, { signal } = {}) {
      const { mode, latencyMs } = scenario();
      // down ném NGAY, không chờ: hạ tầng chết thì không có gì để chờ.
      if (mode === "down") throw new SapTechnicalError("SAP_UNAVAILABLE", "Không kết nối được SAP", { status: null });

      if (mode === "reject") {
        await sleep(300 + latencyMs, signal);
        const partNumber = payload?.data?.partNumber ?? "UNKNOWN";
        throw new SapBusinessError("SAP_PART_UNKNOWN", "SAP từ chối: mã linh kiện không tồn tại", {
          sapMessage: `Material ${partNumber} does not exist in plant 1000`,
        });
      }

      await sleep(successDelay(mode, latencyMs), signal);
      const receiptId = payload?.receiptId;
      const already = issued.get(receiptId);
      if (already) {
        logger?.info("sap.mock_idempotent", { receiptId, sapDocumentNo: already.sapDocumentNo });
        return { ...already };
      }
      seq += 1;
      const result = { sapDocumentNo: docNo("5000", seq), postedAt: new Date().toISOString() };
      issued.set(receiptId, result);
      logger?.info("sap.mock_posted", { receiptId, sapDocumentNo: result.sapDocumentNo, mode });
      return { ...result };
    },

    async reverseGoodsReceipt({ receiptId, sapDocumentNo } = {}, { signal } = {}) {
      const { mode, latencyMs } = scenario();
      if (mode === "down") throw new SapTechnicalError("SAP_UNAVAILABLE", "Không kết nối được SAP", { status: null });

      if (mode === "reject") {
        await sleep(300 + latencyMs, signal);
        throw new SapBusinessError("SAP_DUPLICATE_DOCUMENT", "SAP từ chối huỷ chứng từ", {
          sapMessage: `Document ${sapDocumentNo ?? "?"} cannot be reversed`,
        });
      }

      await sleep(successDelay(mode, latencyMs), signal);
      const already = reversed.get(receiptId);
      if (already) return { ...already };
      reversalSeq += 1;
      const result = { reversalDocumentNo: docNo("5900", reversalSeq), postedAt: new Date().toISOString() };
      reversed.set(receiptId, result);
      logger?.info("sap.mock_reversed", { receiptId, sapDocumentNo, reversalDocumentNo: result.reversalDocumentNo });
      return { ...result };
    },
  };
}
