/* Schema trường nghiệp vụ — nguồn sự thật phía server.
 *
 * Kiểu dữ liệu từng field (đây là hợp đồng với frontend và với adapter AI):
 *   code    : string, viết hoa, bỏ khoảng trắng; có thể kèm regex
 *   text    : string đã trim
 *   integer : số nguyên (JSON number)
 *   number  : số thực (JSON number)
 *   date    : string ISO "YYYY-MM-DD", phải là ngày thật trên lịch
 *   enum    : string phải trùng một phần tử trong options
 *
 * Trong bản ghi receipt: field bắt buộc luôn có giá trị; field tuỳ chọn không nhập → null.
 * Trong kết quả nhận dạng: xem normalizeRecognitionFields.
 */

export const SUPPLIERS = ["Nội bộ — Made in Vietnam", "Jiangsu Tiemao Technology", "Nhà cung cấp khác"];
export const PACKAGING = ["Nguyên vẹn", "Móp nhẹ", "Rách hoặc ướt", "Khác"];

export const PART_NUMBER_RE = /^[A-Z]{3}\d{8}[A-Z]{2,6}$/;
export const SA_NUMBER_RE = /^\d{10}$/;

export const FIELDS = {
  partNumber: { type: "code", required: true, pattern: PART_NUMBER_RE, patternMsg: "Sai định dạng — cần 3 chữ + 8 số + 2–6 chữ" },
  partName: { type: "text", required: true, max: 120 },
  quantity: { type: "integer", required: true, min: 1 },
  shipmentDate: { type: "date", required: true },
  supplier: {
    type: "enum",
    required: true,
    options: SUPPLIERS,
    // Tên/logo hay xuất hiện trên nhãn → option chuẩn. Khớp sau fold (bỏ dấu, hoa thường, ký tự lạ).
    aliases: { "Nội bộ — Made in Vietnam": ["vinfast", "vin fast", "noi bo", "internal", "made in vietnam"], "Jiangsu Tiemao Technology": ["tiemao", "jiangsu tiemao", "jiangsu"] },
  },
  location: { type: "code", required: true, max: 40 },
  batch: { type: "code", required: false, max: 40 },
  saNumber: { type: "code", required: false, pattern: SA_NUMBER_RE, patternMsg: "SA Number phải đủ 10 chữ số" },
  variant: { type: "text", required: false, max: 80 },
  plantDock: { type: "code", required: false, max: 40 },
  grossWeight: { type: "number", required: false, min: 0 },
  packaging: { type: "enum", required: false, options: PACKAGING },
  note: { type: "text", required: false, max: 1000 },
};

export const FIELD_KEYS = Object.keys(FIELDS);

/* ---------- Chuẩn hoá từng kiểu ---------- */

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, "0");

/* Ngày thật trên lịch: 2026-02-31 → false. */
export function isRealDate(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const toIso = (y, m, d) => (isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);

/* Nhận các kiểu ngày trên nhãn thật: 18SEP2026 · 2026/8/21 · 15.09.2026 · 15/9/2026 · 20260821 · 2026-09-15 */
export function parseDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s*([A-Z]{3})\s*(\d{4})$/);
  if (m && MONTHS[m[2]]) return toIso(+m[3], MONTHS[m[2]], +m[1]);
  m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) return toIso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return toIso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return toIso(+m[1], +m[2], +m[3]);
  return null;
}

export const normalizeCode = (raw) => String(raw ?? "").toUpperCase().replace(/\s+/g, "");

/* So khớp enum không phân biệt hoa/thường, dấu, khoảng trắng, ký tự lạ. */
const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/* Khớp chính xác (sau fold) trước; nếu không, chấp nhận chứa chuỗi theo một chiều
 * ("Made in Vietnam" ⊂ "Nội bộ — Made in Vietnam") khi và chỉ khi đúng một option khớp. */
export function matchEnum(raw, options, aliases = {}) {
  if (raw === null || raw === undefined) return null;
  const f = fold(raw);
  if (!f) return null;
  const exact = options.find((o) => fold(o) === f);
  if (exact) return exact;
  for (const [option, list] of Object.entries(aliases)) {
    if (options.includes(option) && list.some((a) => fold(a) === f || (fold(a).length >= 4 && f.includes(fold(a))))) return option;
  }
  if (f.length < 4) return null;
  const partial = options.filter((o) => {
    const fo = fold(o);
    return fo.includes(f) || f.includes(fo);
  });
  return partial.length === 1 ? partial[0] : null;
}

function parseNumber(raw, { integer }) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return integer ? (Number.isInteger(raw) ? raw : null) : raw;
  }
  const s = String(raw).trim().replace(/\s+/g, "").replace(/,/g, ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return integer ? (Number.isInteger(n) ? n : null) : n;
}

/* Trả { value, ok }: ok=false nghĩa là có dữ liệu nhưng không đọc được theo kiểu. value=null khi rỗng. */
export function coerce(key, raw) {
  const f = FIELDS[key];
  if (!f) return { value: null, ok: false };
  if (raw === null || raw === undefined) return { value: null, ok: true };
  switch (f.type) {
    case "code": {
      const v = normalizeCode(raw);
      return { value: v || null, ok: true };
    }
    case "text": {
      const v = String(raw).trim();
      return { value: v || null, ok: true };
    }
    case "integer": {
      const v = parseNumber(raw, { integer: true });
      return { value: v, ok: v !== null || String(raw).trim() === "" };
    }
    case "number": {
      const v = parseNumber(raw, { integer: false });
      return { value: v, ok: v !== null || String(raw).trim() === "" };
    }
    case "date": {
      if (String(raw).trim() === "") return { value: null, ok: true };
      const v = parseDate(raw);
      return { value: v, ok: v !== null };
    }
    case "enum": {
      if (String(raw).trim() === "") return { value: null, ok: true };
      const v = matchEnum(raw, f.options, f.aliases);
      return { value: v, ok: v !== null };
    }
    default:
      return { value: null, ok: false };
  }
}

/* ---------- Kết quả nhận dạng ---------- */

/* Đầu vào: { key: { value: any, confidence?: number } } đã được adapter ánh xạ về key của form.
 * Đầu ra: { fields, warnings }
 *   fields[key] = { value, confidence, raw, status }
 *     value      : giá trị đã chuẩn hoá theo kiểu, hoặc null
 *     confidence : 0..1; bị hạ về 0 khi không chuẩn hoá được
 *     raw        : chuỗi provider trả về nguyên bản (để người dùng đối chiếu), hoặc null
 *     status     : "ok" | "unparsed" (có raw nhưng không đọc được) | "missing" (provider không trả)
 *   Mọi key trong FIELDS đều có mặt, để frontend không phải đoán.
 */
export function normalizeRecognitionFields(rawFields) {
  const fields = {};
  const warnings = [];
  const src = rawFields && typeof rawFields === "object" ? rawFields : {};

  for (const key of Object.keys(src)) {
    if (!FIELDS[key]) warnings.push(`Provider trả key không có trong schema: ${key}`);
  }

  for (const key of FIELD_KEYS) {
    const entry = src[key];
    const hasEntry = entry && typeof entry === "object" && entry.value !== undefined && entry.value !== null && String(entry.value).trim() !== "";
    if (!hasEntry) {
      fields[key] = { value: null, confidence: 0, raw: null, status: "missing" };
      continue;
    }
    const raw = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
    let confidence = Number(entry.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    const { value, ok } = coerce(key, entry.value);
    if (!ok || value === null) {
      fields[key] = { value: null, confidence: 0, raw, status: "unparsed" };
    } else {
      // Mã không đúng định dạng (LLM hay thêm/bớt một ký tự): giữ giá trị để người dùng sửa một chữ,
      // nhưng kẹp confidence ≤ 0.5 để webapp gắn cờ "kiểm tra lại".
      const f = FIELDS[key];
      if (f.pattern && !f.pattern.test(value)) confidence = Math.min(confidence, 0.5);
      fields[key] = { value, confidence, raw, status: "ok" };
    }
  }
  // LLM hay chép batch/part number vào variant. Trùng nguyên văn với trường khác → coi là không đọc được.
  const v = fields.variant;
  if (v.status === "ok" && ["batch", "partNumber", "saNumber", "plantDock"].some((k) => fields[k].value !== null && String(fields[k].value) === String(v.value))) {
    fields.variant = { value: null, confidence: 0, raw: v.raw, status: "unparsed" };
    warnings.push("variant trùng giá trị trường khác, đã bỏ");
  }
  return { fields, warnings };
}

/* ---------- Validation bản ghi xác nhận ---------- */

/* Đầu vào: object data từ client (giá trị có thể là string do form). Trả:
 *   { ok: boolean, errors: { key: message }, data: object đã ép kiểu (chỉ khi ok) }
 */
export function validateReceiptData(input) {
  const errors = {};
  const data = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: { _: "data phải là object" }, data: null };
  }
  for (const key of Object.keys(input)) {
    if (!FIELDS[key]) errors[key] = "Trường không có trong schema";
  }
  for (const key of FIELD_KEYS) {
    const f = FIELDS[key];
    const raw = input[key];
    const { value, ok } = coerce(key, raw);
    if (!ok) {
      errors[key] =
        f.type === "date" ? "Ngày không hợp lệ" : f.type === "enum" ? "Giá trị không nằm trong danh sách cho phép" : "Phải là số hợp lệ";
      continue;
    }
    if (value === null) {
      if (f.required) errors[key] = "Chưa có dữ liệu";
      else data[key] = null;
      continue;
    }
    if (f.pattern && !f.pattern.test(value)) {
      errors[key] = f.patternMsg;
      continue;
    }
    if (f.max !== undefined && String(value).length > f.max) {
      errors[key] = `Tối đa ${f.max} ký tự`;
      continue;
    }
    if (f.min !== undefined && value < f.min) {
      errors[key] = key === "quantity" ? "Số lượng phải lớn hơn 0" : `Phải ≥ ${f.min}`;
      continue;
    }
    data[key] = value;
  }
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, data: ok ? data : null };
}
