import { isUuidV4 } from "../devices.js";
import { SEVERITIES } from "../events.js";

/* Hai endpoint đọc cho màn hình giám sát S9 (§4.6, §4.7 của hợp đồng Phase 5).
 *
 * Cả hai nằm dưới /api/admin/ nên được sim middleware MIỄN TRỪ hoàn toàn: monitor phải sống
 * được đúng lúc hệ thống "chết" (backend.mode=down) — nếu không thì nó vô dụng ở đúng tình
 * huống người ta cần nó nhất. Không có xác thực ở Phase 5 (QUYẾT ĐỊNH O-3).
 *
 * Nết khoan dung được giữ nguyên của Phase 1: tham số LỌC sai thì bỏ lọc, không báo lỗi;
 * chỉ `since` sai mới là lỗi, vì `since` hỏng nghĩa là client đang phân trang sai và sẽ lặng
 * lẽ bỏ sót sự kiện. */

const RECOGNITION_STATUSES = new Set(["pending", "completed", "failed"]);

/* Kẹp về biên thay vì báo lỗi, giống GET /api/receipts và GET /api/master/locations. */
function clampedLimit(url, { fallback, max }) {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

/* `?type=a&type=b` và `?type=a,b` đều hợp lệ và trộn được với nhau: FE-2 dựng query từ một
 * mảng checkbox, còn người gõ tay hay dùng dấu phẩy. */
export function parseTypes(url) {
  const list = url.searchParams
    .getAll("type")
    .flatMap((raw) => String(raw).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : null;
}

export function adminRoutes({ events, recognition, ApiError }) {
  return [
    {
      method: "GET",
      pattern: /^\/api\/admin\/events$/,
      handler: async (_req, _m, url) => {
        const rawSince = url.searchParams.get("since");
        if (rawSince !== null && rawSince !== "" && !/^\d+$/.test(rawSince)) {
          throw new ApiError(400, "INVALID_SINCE", "Tham số since phải là số nguyên không âm", { since: rawSince });
        }
        const since = rawSince === null || rawSince === "" ? 0 : Number.parseInt(rawSince, 10);
        const severityRaw = url.searchParams.get("severity");
        const deviceIdRaw = url.searchParams.get("deviceId");
        const { items, lastId, hasMore, oldestId } = events.list({
          since,
          limit: clampedLimit(url, { fallback: 50, max: 200 }),
          types: parseTypes(url),
          severity: SEVERITIES.includes(severityRaw) ? severityRaw : null,
          deviceId: isUuidV4(deviceIdRaw) ? deviceIdRaw : null,
        });
        /* `oldestId` đi kèm MỌI response, kể cả khi trang này rỗng: nó là thứ duy nhất cho
         * client biết vòng xoay đã cắt qua `since` của mình — và trang rỗng chính là lúc
         * người đọc dễ tưởng "không có gì mới" trong khi thật ra đã mất dòng. */
        return { status: 200, body: { items, lastId, hasMore, oldestId, serverTime: new Date().toISOString() } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/admin\/recognitions$/,
      handler: async (_req, _m, url) => {
        const statusRaw = url.searchParams.get("status");
        /* serverTime lấy MỘT LẦN và dùng cho cả ageMs: hai lần gọi Date.now() sẽ làm
         * `ageMs` không khớp `serverTime - createdAt` mà người kiểm tính tay. */
        const now = Date.now();
        const { items, counts } = recognition.listForAdmin({
          status: RECOGNITION_STATUSES.has(statusRaw) ? statusRaw : null,
          limit: clampedLimit(url, { fallback: 20, max: 100 }),
          now,
        });
        return { status: 200, body: { items, counts, serverTime: new Date(now).toISOString() } };
      },
    },
  ];
}
