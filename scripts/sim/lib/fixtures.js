/* Dữ liệu mẫu cho thiết bị ảo: ảnh JPEG hợp lệ + bộ sinh dữ liệu phiếu hợp lệ.
 *
 * "Hợp lệ" ở đây nghĩa là qua được fields.js của máy chủ. Nếu dữ liệu sai thì mọi phiếu
 * trả 422 và kịch bản đo được đúng một thứ: bộ sinh dữ liệu hỏng. Các hằng dưới đây là BẢN
 * CHÉP của hợp đồng (S2: không import gì từ mã nguồn ứng dụng), chép sai là lỗi của file này.
 */

import fs from "node:fs";

/* JPEG 1×1 hợp lệ, 134 byte — chép hằng từ helpers.js của bộ test máy chủ (không import). */
export const JPEG_1X1_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

export const JPEG_1X1 = Buffer.from(JPEG_1X1_BASE64, "base64");

/* Khớp fields.js: SUPPLIERS[0]. Ba giá trị enum, thiết bị ảo dùng giá trị nội bộ. */
export const SUPPLIER_INTERNAL = "Nội bộ — Made in Vietnam";
export const PART_NAME = "BATTERY_PACK_REAR_FENDER";

/* Vị trí dự phòng khi GET /api/master/locations không trả được gì (05-virtual-devices.md §2.2).
 * Nếu kho mẫu không có mã này thì phiếu sẽ nhận 422 LOCATION_UNKNOWN và kịch bản BÁO KHÔNG ĐẠT —
 * đúng như phải thế: im lặng bỏ trường bắt buộc mới là hành vi sai. */
export const FALLBACK_LOCATION = "A-03-02";

/** "YYYY-MM-DD" theo lịch địa phương (kho chạy ở VN, ngày nghiệp vụ là ngày địa phương). */
export function todayLocalIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Sinh một bộ dữ liệu phiếu hợp lệ.
 *
 * @param {object} p
 * @param {{digits:Function,int:Function}} p.rng   PRNG tất định theo --seed
 * @param {string} p.location                      lấy từ máy chủ, KHÔNG đoán
 * @param {boolean} [p.sameLabel]                  mọi thiết bị dùng chung một nhãn (kiểm M07)
 * @param {boolean} [p.invalid]                    cố tình bỏ partNumber để sinh 422
 */
export function makeReceiptData({ rng, location, sameLabel = false, invalid = false, now = new Date() } = {}) {
  if (!rng || typeof rng.digits !== "function") throw new Error("makeReceiptData cần một rng của lib/rng.js");
  const partNumber = sameLabel ? "BEX00000001AB" : `BEX${rng.digits(8)}AB`;
  const batch = sameLabel ? "B000001" : `B${rng.digits(6)}`;
  const saNumber = sameLabel ? "0000000001" : rng.digits(10);
  const data = {
    partNumber,
    partName: PART_NAME,
    quantity: rng.int(1, 200),
    shipmentDate: todayLocalIso(now),
    supplier: SUPPLIER_INTERNAL,
    location,
    batch,
    saNumber,
  };
  /* --fail-rate: bỏ ĐÚNG trường bắt buộc partNumber. Không bịa giá trị sai định dạng, vì
   * "thiếu trường" và "sai định dạng" là hai mã lỗi khác nhau trong fields.js và kịch bản
   * cần loại 422 nào cũng được miễn là do ta cố ý. */
  if (invalid) delete data.partNumber;
  return data;
}

/** Ảnh dùng cho upload: --image <path> nếu có, ngược lại JPEG 1×1 dựng sẵn. */
export function loadImage(imagePath = null) {
  if (!imagePath) return { buffer: JPEG_1X1, mimeType: "image/jpeg", name: "label.jpg" };
  const buffer = fs.readFileSync(imagePath);
  const lower = imagePath.toLowerCase();
  const mimeType = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { buffer, mimeType, name: imagePath.split("/").pop() || "label.jpg" };
}

/** FormData cho POST /api/recognitions (multipart, field "image"). */
export function imageForm({ buffer, mimeType, name }) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mimeType }), name);
  return form;
}
