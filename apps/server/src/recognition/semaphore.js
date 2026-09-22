/* Semaphore + hàng đợi FIFO cho nhận dạng.
 *
 * Slot được xin TRƯỚC khi lưu ảnh và trước khi tạo dòng recognitions (Q11): một request bị
 * 429 không để lại file ảnh, không để lại dòng DB nào. */

export class RecognitionBusyError extends Error {
  constructor(details) {
    super("Máy chủ đang xử lý nhiều ảnh, hãy thử lại sau ít giây");
    this.code = "RECOGNITION_BUSY";
    this.status = 429;
    this.details = details;
  }
}

export function createSemaphore({ maxConcurrent = 3, maxWaiting = 10, maxWaitMs = 30000, retryAfterMs = 3000 } = {}) {
  let inflight = 0;
  const queue = [];

  const busy = () =>
    new RecognitionBusyError({ retryAfterMs, inflight, waiting: queue.length });

  return {
    stats: () => ({ inflight, waiting: queue.length }),

    /* Thuần đọc, KHÔNG đổi gì. Chế độ async phải biết "còn nhận được không" NGAY trong handler
     * (đồng bộ) để trả 429 trước khi lưu ảnh; acquire() ở chế độ đó không bao giờ reject bằng
     * RecognitionBusyError nữa vì đã hỏi trước. Chế độ sync không dùng hàm này. */
    canAdmit: () => inflight < maxConcurrent || queue.length < maxWaiting,

    /* signal (tuỳ chọn): client ngắt kết nối khi còn đang XẾP HÀNG thì phải rời hàng ngay,
     * nhường chỗ cho người tiếp theo — nếu không, chỗ chờ đó bị giữ cho một người đã bỏ đi
     * và request kế tiếp lãnh 429 oan. */
    acquire(signal = null) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
      if (inflight < maxConcurrent) {
        inflight += 1;
        return Promise.resolve();
      }
      if (queue.length >= maxWaiting) return Promise.reject(busy());

      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null, onAbort: null };
        entry.leave = () => {
          const i = queue.indexOf(entry);
          if (i >= 0) queue.splice(i, 1);
          clearTimeout(entry.timer);
          if (entry.onAbort) signal?.removeEventListener("abort", entry.onAbort);
        };
        // Chờ quá lâu cũng là bận: trả 429 để PDA biết thử lại, thay vì treo tới timeout.
        entry.timer = setTimeout(() => {
          entry.leave();
          reject(busy());
        }, maxWaitMs);
        entry.timer.unref?.();
        if (signal) {
          entry.onAbort = () => {
            entry.leave();
            reject(signal.reason ?? new Error("aborted"));
          };
          signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        queue.push(entry);
      });
    },

    release() {
      const next = queue.shift();
      if (next) {
        next.leave(); // dọn timer + listener; entry đã rời hàng nên splice là no-op
        next.resolve(); // slot chuyển thẳng cho người kế tiếp: inflight không đổi
        return;
      }
      inflight = Math.max(0, inflight - 1);
    },
  };
}
