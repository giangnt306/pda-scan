/* Quyết định sim middleware — hàm thuần để test được mà không cần dựng server.
 * Chạy sau khi đã parse header, trước khi tìm route. */

export const SIM_RETRY_AFTER_MS = 5000;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const pass = (latencyMs = 0) => ({ action: "pass", latencyMs });

export function decideSim({ method, pathname, effective, simOverride }) {
  if (!simOverride) return pass(0);

  const mode = effective?.backend?.mode ?? "normal";
  // latencyMs chỉ có tác dụng ở mode degraded (§5.1) — down/readonly chặn ngay, không chờ.
  const latencyMs = mode === "degraded" ? Math.max(0, Number(effective?.backend?.latencyMs) || 0) : 0;

  /* /api/admin/* miễn trừ HOÀN TOÀN: phải luôn tắt được kịch bản, kể cả khi vừa đặt
   * latencyMs=30000. Đây là đường thoát hiểm duy nhất. */
  if (pathname === "/api/admin/sim" || pathname.startsWith("/api/admin/")) return pass(0);

  /* /api/status là kênh sống của PDA: không bị down/readonly chặn, NHƯNG vẫn chịu latency
   * (Q9) — "máy chủ chậm" là tình trạng PDA cần quan sát được, không phải thứ để giấu. */
  if (pathname === "/api/status") return pass(latencyMs);

  if (mode === "down") {
    return {
      action: "block",
      latencyMs: 0,
      status: 503,
      code: "BACKEND_DOWN_SIMULATED",
      message: "Mô phỏng: máy chủ đang ngừng hoạt động",
      details: { retryAfterMs: SIM_RETRY_AFTER_MS, simulated: true },
    };
  }
  if (mode === "readonly" && WRITE_METHODS.has(method)) {
    return {
      action: "block",
      latencyMs: 0,
      status: 503,
      code: "BACKEND_READONLY",
      message: "Mô phỏng: máy chủ đang ở chế độ chỉ đọc, không ghi được",
      details: { retryAfterMs: SIM_RETRY_AFTER_MS, simulated: true },
    };
  }
  return pass(latencyMs);
}
