/* Chuẩn hoá dữ liệu thô trước khi đổ vào form.
 *
 * Bốn nhãn mẫu cho ra bốn kiểu ngày khác nhau:
 *   "15.09.2026"  (dấu mộc)
 *   "2026/8/21"   (nhà cung cấp Trung Quốc)
 *   "18SEP2026"   (nhãn in của VinFast)
 *   "15/9/2026"   (viết tay)
 * Để model tự trả về ISO là không đáng tin, nên tự quy đổi ở đây.
 */

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) =>
  y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31
    ? `${y}-${pad(m)}-${pad(d)}`
    : "";

export function normalizeDate(raw) {
  if (!raw) return "";
  const s = String(raw).trim().toUpperCase();

  // 18SEP2026
  let m = s.match(/^(\d{1,2})\s*([A-Z]{3})\s*(\d{4})$/);
  if (m && MONTHS[m[2]]) return iso(+m[3], MONTHS[m[2]], +m[1]);

  // 2026/8/21 · 2026-08-21 · 2026.8.21  (năm đứng trước)
  m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  // 15/9/2026 · 15.09.2026 · 15-9-2026  (ngày đứng trước, kiểu VN)
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return iso(+m[3], +m[2], +m[1]);

  // 20260821 liền nhau
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  return "";
}

/* Mã linh kiện: bỏ khoảng trắng, viết hoa. Không tự sửa 0/O ở đây —
 * việc đó để regex bên dưới báo lỗi cho người kiểm tra quyết định. */
export function normalizeCode(raw) {
  return String(raw || "").toUpperCase().replace(/\s+/g, "");
}

/* Quy luật rút từ 4 nhãn mẫu:
 *   BIN75151170ABBRA · BEX75149000AB · BEX32181030AB
 *   = 3 chữ cái + 8 chữ số + 2..6 chữ cái  */
export const PART_NUMBER_RE = /^[A-Z]{3}\d{8}[A-Z]{2,6}$/;

/* SA Number trên nhãn mẫu: 5300013959, 5300013009 — 10 chữ số */
export const SA_NUMBER_RE = /^\d{10}$/;
