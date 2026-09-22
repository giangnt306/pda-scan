/* Sổ theo dõi các job nhận dạng đang chạy NỀN (chế độ RECOGNITION_MODE=async).
 *
 * Nhỏ có chủ ý: không một dòng logic nghiệp vụ nào ở đây. Nó tồn tại vì đúng hai lý do:
 *  1. Không có ai giữ tham chiếu thì một promise nền bị reject sẽ thành `unhandledRejection`
 *     và làm đỏ cả bộ test ở một file chẳng liên quan gì.
 *  2. app.close() phải chờ job nền xong trước khi db.close(), nếu không job sẽ prepare() trên
 *     một DB đã đóng và ném ERR_SQLITE ra ngoài mọi try/catch (cạm bẫy L12 của Phase 4). */

export function createAsyncJobs({ logger } = {}) {
  /** recognitionId -> promise đang chạy */
  const jobs = new Map();

  return {
    /** Giữ tham chiếu tới promise của job; tự gỡ khi promise settle (dù xong hay lỗi). */
    track(recognitionId, promise) {
      if (!recognitionId || !promise || typeof promise.then !== "function") return;
      /* .catch BẮT BUỘC: job nền không có ai await, một rejection lọt ra là unhandledRejection. */
      const guarded = Promise.resolve(promise).catch((err) => {
        logger?.warn("recognition.async_job_failed", { recognitionId, error: err?.message });
      });
      jobs.set(recognitionId, guarded);
      guarded.finally(() => {
        // Chỉ xoá đúng promise của mình: cùng một recognitionId không bao giờ chạy hai lần,
        // nhưng xoá theo khoá mà không kiểm sẽ là một cái bẫy im lặng nếu sau này có.
        if (jobs.get(recognitionId) === guarded) jobs.delete(recognitionId);
      });
    },

    /** Số job đang chạy nền. */
    size() {
      return jobs.size;
    },

    /** Chờ mọi job xong, tối đa timeoutMs. Trả true nếu đã cạn, false nếu hết giờ. */
    async drain(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (jobs.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          logger?.warn("recognition.async_drain_timeout", { pending: jobs.size, timeoutMs });
          return false;
        }
        const timer = new Promise((resolve) => setTimeout(resolve, remaining).unref?.());
        await Promise.race([Promise.allSettled([...jobs.values()]), timer]);
        /* Vòng lặp chứ không một lần: một job xong có thể chưa kịp gỡ khỏi Map (finally chạy ở
         * microtask sau), và về nguyên tắc job mới vẫn có thể được track trong lúc chờ. */
        await Promise.resolve();
      }
      return true;
    },
  };
}
