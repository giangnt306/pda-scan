/* Ba endpoint tra cứu danh mục dữ liệu chủ (§7.1–§7.3).
 *
 * Cả ba là GET, không yêu cầu header nào ngoài x-request-id, và đi qua sim middleware như mọi
 * endpoint khác: backend.mode=down chặn cả danh mục (§14 câu 15 — chủ ý, để S1/S4 phải xử lý được).
 */

const MAX_Q = 40;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/* limit sai/ngoài khoảng thì KẸP chứ không báo lỗi (giữ đúng nết khoan dung của Phase 1 với
 * ?limit=); chỉ q quá dài mới là lỗi, vì nó báo hiệu FE đang gửi nhầm trường. */
function limitOf(url) {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

export function masterRoutes({ master, ApiError }) {
  return [
    {
      method: "GET",
      pattern: /^\/api\/master\/locations$/,
      handler: async (_req, _m, url) => {
        const q = url.searchParams.get("q");
        if (q !== null && q.length > MAX_Q) {
          throw new ApiError(400, "INVALID_QUERY", "Tham số truy vấn không hợp lệ", { field: "q" });
        }
        /* Chỉ chuỗi "true" mới bật; mọi giá trị khác, kể cả vắng mặt, là false. */
        const includeInactive = url.searchParams.get("includeInactive") === "true";
        const { items, total } = master.locations({ q: q ?? undefined, limit: limitOf(url), includeInactive });
        return {
          status: 200,
          body: { items, total, truncated: total > items.length, serverTime: new Date().toISOString() },
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/master\/warehouses$/,
      handler: async () => ({ status: 200, body: { items: master.warehouses(), serverTime: new Date().toISOString() } }),
    },
    {
      method: "GET",
      pattern: /^\/api\/master\/shifts$/,
      handler: async () => ({ status: 200, body: { items: master.shifts(), serverTime: new Date().toISOString() } }),
    },
  ];
}
