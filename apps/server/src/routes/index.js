import { masterRoutes } from "./master.js";
import { rulesRoutes } from "./rules.js";
import { adminRoutes } from "./admin.js";

/* Điểm cắm route cho BE-2. BE-1 KHÔNG hiện thực hai module dưới, chỉ tạo stub ở Stage 1.
 * Kết quả được nối vào CUỐI mảng routes của http.js (Q36): routes.find lấy khớp đầu tiên,
 * nên route lõi luôn thắng và BE-2 không thể vô tình ghi đè endpoint của BE-1. */
export function extraRoutes(ctx) {
  return [...masterRoutes(ctx), ...rulesRoutes(ctx), ...adminRoutes(ctx)];
}
