import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDate, isRealDate, coerce, normalizeRecognitionFields, validateReceiptData, matchEnum, SUPPLIERS } from "../src/fields.js";

test("parseDate nhận các định dạng trên nhãn thật", () => {
  assert.equal(parseDate("18SEP2026"), "2026-09-18");
  assert.equal(parseDate("2026/8/21"), "2026-08-21");
  assert.equal(parseDate("15.09.2026"), "2026-09-15");
  assert.equal(parseDate("15/9/2026"), "2026-09-15");
  assert.equal(parseDate("20260821"), "2026-08-21");
  assert.equal(parseDate("2026-09-15"), "2026-09-15");
  assert.equal(parseDate("rubbish"), null);
  assert.equal(parseDate(""), null);
  assert.equal(parseDate(null), null);
});

test("ngày phải tồn tại thật trên lịch", () => {
  assert.equal(parseDate("31/02/2026"), null);
  assert.equal(parseDate("2026-02-31"), null);
  assert.equal(parseDate("29/02/2028"), "2028-02-29"); // năm nhuận
  assert.equal(parseDate("29/02/2027"), null);
  assert.equal(parseDate("31/04/2026"), null);
  assert.equal(isRealDate(1999, 1, 1), false); // ngoài khoảng năm
});

test("matchEnum bỏ qua dấu, hoa thường, ký tự lạ", () => {
  assert.equal(matchEnum("noi bo - made in vietnam", SUPPLIERS), "Nội bộ — Made in Vietnam");
  assert.equal(matchEnum("JIANGSU TIEMAO TECHNOLOGY", SUPPLIERS), "Jiangsu Tiemao Technology");
  assert.equal(matchEnum("Foxconn", SUPPLIERS), null);
  assert.equal(matchEnum("Made in Vietnam", SUPPLIERS), "Nội bộ — Made in Vietnam"); // chứa chuỗi, duy nhất
  assert.equal(matchEnum("Jiangsu Tiemao Technology Co., Ltd", SUPPLIERS), "Jiangsu Tiemao Technology");
  assert.equal(matchEnum("nhà", SUPPLIERS), null); // quá ngắn, không đoán
  assert.equal(coerce("supplier", "VINFAST").value, "Nội bộ — Made in Vietnam"); // alias
  assert.equal(coerce("supplier", "Jiangsu Tiemao Technology Co., Ltd.").value, "Jiangsu Tiemao Technology");
  assert.equal(coerce("supplier", "Jiangsu Tiansmao Technology Co. Ltd").value, "Jiangsu Tiemao Technology"); // OCR lệch chữ, khớp theo "jiangsu"
});

test("coerce ép kiểu theo schema", () => {
  assert.deepEqual(coerce("quantity", "80"), { value: 80, ok: true });
  assert.deepEqual(coerce("quantity", 80), { value: 80, ok: true });
  assert.deepEqual(coerce("quantity", "80.5"), { value: null, ok: false });
  assert.deepEqual(coerce("quantity", "abc"), { value: null, ok: false });
  assert.deepEqual(coerce("quantity", ""), { value: null, ok: true });
  assert.deepEqual(coerce("grossWeight", "12,5"), { value: 12.5, ok: true });
  assert.deepEqual(coerce("partNumber", " bex 32181030ab "), { value: "BEX32181030AB", ok: true });
  assert.deepEqual(coerce("shipmentDate", "15/9/2026"), { value: "2026-09-15", ok: true });
  assert.deepEqual(coerce("shipmentDate", "31/02/2026"), { value: null, ok: false });
  assert.deepEqual(coerce("nope", "x"), { value: null, ok: false });
});

test("normalizeRecognitionFields: đủ mọi key, hạ confidence khi không parse được, cảnh báo key lạ", () => {
  const { fields, warnings } = normalizeRecognitionFields({
    partNumber: { value: "bex32181030ab", confidence: 0.94 },
    quantity: { value: "80", confidence: 0.91 },
    shipmentDate: { value: "31/02/2026", confidence: 0.99 },
    supplier: { value: "Foxconn", confidence: 0.8 },
    grossWeight: { value: 7, confidence: 1.7 },
    sku: { value: "X", confidence: 1 },
  });
  assert.equal(Object.keys(fields).length, 13);
  assert.deepEqual(fields.partNumber, { value: "BEX32181030AB", confidence: 0.94, raw: "bex32181030ab", status: "ok" });
  assert.equal(fields.quantity.value, 80);
  assert.equal(typeof fields.quantity.value, "number");
  assert.deepEqual(fields.shipmentDate, { value: null, confidence: 0, raw: "31/02/2026", status: "unparsed" });
  assert.deepEqual(fields.supplier, { value: null, confidence: 0, raw: "Foxconn", status: "unparsed" });
  assert.equal(fields.grossWeight.confidence, 1); // kẹp về [0,1]
  const bad = normalizeRecognitionFields({ partNumber: { value: "BEX751490000AB", confidence: 0.9 }, saNumber: { value: "5300013009", confidence: 0.9 } }).fields;
  assert.deepEqual(bad.partNumber, { value: "BEX751490000AB", confidence: 0.5, raw: "BEX751490000AB", status: "ok" }); // 9 số → kẹp 0.5
  assert.equal(bad.saNumber.confidence, 0.9);
  const dup = normalizeRecognitionFields({ batch: { value: "260917_79F", confidence: 0.9 }, variant: { value: "260917_79F", confidence: 0.9 } });
  assert.equal(dup.fields.variant.status, "unparsed");
  assert.equal(dup.fields.variant.raw, "260917_79F");
  assert.equal(dup.fields.batch.value, "260917_79F");
  assert.equal(normalizeRecognitionFields({ variant: { value: "Limo Green", confidence: 0.9 } }).fields.variant.value, "Limo Green");
  assert.deepEqual(fields.location, { value: null, confidence: 0, raw: null, status: "missing" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sku/);
});

test("validateReceiptData: hợp lệ → dữ liệu đã ép kiểu, tuỳ chọn rỗng → null", () => {
  const r = validateReceiptData({
    partNumber: "bex32181030ab",
    partName: " BATTERY ",
    quantity: "80",
    shipmentDate: "2026-09-15",
    supplier: "Nội bộ — Made in Vietnam",
    location: "a-03-02",
    saNumber: "",
    grossWeight: 12.5,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.data.quantity, 80);
  assert.equal(r.data.partNumber, "BEX32181030AB");
  assert.equal(r.data.partName, "BATTERY");
  assert.equal(r.data.location, "A-03-02");
  assert.equal(r.data.saNumber, null);
  assert.equal(r.data.note, null);
  assert.equal(r.data.grossWeight, 12.5);
});

test("validateReceiptData: báo đúng lỗi từng trường", () => {
  const r = validateReceiptData({
    partNumber: "BEX321",
    partName: "",
    quantity: "0",
    shipmentDate: "2026-02-31",
    supplier: "Foxconn",
    location: "A1",
    saNumber: "123",
    packaging: "Vỡ nát",
    bogus: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.match(r.errors.partNumber, /định dạng/);
  assert.equal(r.errors.partName, "Chưa có dữ liệu");
  assert.equal(r.errors.quantity, "Số lượng phải lớn hơn 0");
  assert.equal(r.errors.shipmentDate, "Ngày không hợp lệ");
  assert.match(r.errors.supplier, /danh sách/);
  assert.match(r.errors.saNumber, /10 chữ số/);
  assert.match(r.errors.packaging, /danh sách/);
  assert.match(r.errors.bogus, /schema/);
  assert.equal(r.errors.location, undefined);
});

test("validateReceiptData: quantity dạng number không gây lỗi", () => {
  const r = validateReceiptData({ ...{ partNumber: "BEX32181030AB", partName: "X", quantity: 5, shipmentDate: "2026-01-01", supplier: SUPPLIERS[0], location: "A" } });
  assert.equal(r.ok, true);
  assert.equal(r.data.quantity, 5);
  assert.equal(validateReceiptData(null).ok, false);
  assert.equal(validateReceiptData([]).ok, false);
});
