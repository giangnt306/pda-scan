/* Rule "vị trí phải có trong danh mục kho".
 *
 * Chạy TRƯỚC rule trùng nhãn (Q31): vị trí sai là lỗi dữ liệu sửa được ngay tại form, còn trùng
 * nhãn là quyết định của con người. Báo lỗi dữ liệu trước để người vận hành không phải bấm
 * "Vẫn lưu" rồi mới biết vị trí sai.
 */
import { ReceiptError } from "../receipts.js";

/**
 * @param {{ data: object, config: object, master: object }} p  data ĐÃ qua validateReceiptData
 * @throws {ReceiptError} 422 LOCATION_UNKNOWN
 */
export function checkLocation({ data, config, master }) {
  if (config?.rules?.location !== true) return;
  const value = data?.location ?? null;
  /* master.hasLocation tự fail-open khi danh mục chưa nạp được hoặc rỗng (Q28). */
  if (master.hasLocation(value) === true) return;
  throw new ReceiptError(422, "LOCATION_UNKNOWN", "Vị trí không có trong danh mục kho", {
    field: "location",
    value,
    /* suggestions LUÔN là mảng (rỗng khi không có mã nào cùng ký tự đầu) — FE đọc .length
     * không cần kiểm tra key có mặt hay không. */
    suggestions: master.suggestLocations(value, 3),
  });
}
