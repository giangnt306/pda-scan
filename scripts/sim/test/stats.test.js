import test from "node:test";
import assert from "node:assert/strict";
import { percentile, summarize } from "../lib/stats.js";

const ONE_TO_100 = Array.from({ length: 100 }, (_, i) => i + 1);

test("percentile của [1..100] cho p50=50 và p95=95", () => {
  assert.equal(percentile(ONE_TO_100, 50), 50);
  assert.equal(percentile(ONE_TO_100, 95), 95);
});

test("percentile của mảng rỗng trả null cho mọi phân vị và n=0", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([], 99), null);
  const s = summarize([]);
  assert.deepEqual(s, { p50: null, p95: null, min: null, max: null, n: 0 });
});

test("summarize trả đúng min, max, n và không làm thay đổi mảng đầu vào", () => {
  const input = [300, 10, 55, 900, 42];
  const copy = [...input];
  const s = summarize(input);
  assert.equal(s.min, 10);
  assert.equal(s.max, 900);
  assert.equal(s.n, 5);
  assert.equal(s.p50, 55);
  // summarize sắp xếp để tính phân vị; sắp xếp tại chỗ sẽ làm đảo thứ tự mẫu đo của phía gọi.
  assert.deepEqual(input, copy);
});
