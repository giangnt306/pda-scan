import test from "node:test";
import assert from "node:assert/strict";
import { makeReceiptData, JPEG_1X1, todayLocalIso } from "../lib/fixtures.js";
import { createRng } from "../lib/rng.js";

test("makeReceiptData sinh partNumber khớp /^[A-Z]{3}\\d{8}[A-Z]{2,6}$/ và saNumber đúng 10 chữ số", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const data = makeReceiptData({ rng: createRng(seed), location: "A-01-01" });
    assert.match(data.partNumber, /^[A-Z]{3}\d{8}[A-Z]{2,6}$/, `seed ${seed} → ${data.partNumber}`);
    assert.match(data.saNumber, /^\d{10}$/, `seed ${seed} → ${data.saNumber}`);
    assert.match(data.batch, /^B\d{6}$/);
    assert.ok(Number.isInteger(data.quantity) && data.quantity >= 1 && data.quantity <= 200);
    assert.equal(data.shipmentDate, todayLocalIso());
    assert.equal(data.location, "A-01-01");
  }
});

test("makeReceiptData với cùng seed cho cùng partNumber, với seed khác cho partNumber khác", () => {
  const a = makeReceiptData({ rng: createRng(42), location: "A-01-01" });
  const b = makeReceiptData({ rng: createRng(42), location: "A-01-01" });
  const c = makeReceiptData({ rng: createRng(43), location: "A-01-01" });
  assert.equal(a.partNumber, b.partNumber);
  assert.notEqual(a.partNumber, c.partNumber);
});

test("makeReceiptData với invalid=true bỏ hẳn partNumber để máy chủ trả 422", () => {
  const data = makeReceiptData({ rng: createRng(7), location: "A-01-01", invalid: true });
  assert.equal("partNumber" in data, false);
  // Các trường bắt buộc còn lại vẫn hợp lệ: 422 phải đến từ đúng một nguyên nhân ta cố ý gây ra.
  assert.equal(data.partName, "BATTERY_PACK_REAR_FENDER");
  assert.equal(data.location, "A-01-01");
});

test("JPEG dựng sẵn dài 134 byte và bắt đầu bằng chữ ký SOI của JPEG", () => {
  assert.equal(JPEG_1X1.length, 134);
  assert.equal(JPEG_1X1[0], 0xff);
  assert.equal(JPEG_1X1[1], 0xd8);
});
