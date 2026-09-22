/* PRNG mulberry32 — tất định theo --seed (S4 của 05-virtual-devices.md).
 *
 * Sinh ngẫu nhiên của ngôn ngữ bị cấm trong cả thư mục này: hai lần chạy cùng seed phải cho cùng dữ liệu
 * phiếu, nếu không thì "chạy lại để xem lỗi có lặp không" là vô nghĩa.
 *
 * LƯU Ý CÓ CHỦ Ý: requestId nghiệp vụ KHÔNG lấy từ đây (xem fixtures.js). Nếu requestId cũng
 * tất định thì lần chạy thứ hai với cùng seed sẽ đụng khoá idempotency của BE và mọi phiếu
 * trả 200 idempotent thay vì 201 — receipts.delta sẽ bằng 0 và kịch bản báo sai.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed = 1) {
  const next = mulberry32(seed);
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    /** Chuỗi n chữ số thập phân, giữ cả số 0 đứng đầu (saNumber "0043118829" là hợp lệ). */
    digits(n) {
      let out = "";
      for (let i = 0; i < n; i += 1) out += String(int(0, 9));
      return out;
    },
    pick(list) {
      if (!Array.isArray(list) || list.length === 0) throw new Error("pick() cần một mảng không rỗng");
      return list[int(0, list.length - 1)];
    },
  };
}
