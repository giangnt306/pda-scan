import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parseScenarioArgs, MISSING_BASE_DEVICES, MISSING_BASE_SCENARIO, isOutsideSimPortRange } from "../lib/args.js";

const withBase = (...extra) => ["--base", "http://127.0.0.1:39500", ...extra];

test("parseArgs áp đúng mặc định khi chỉ truyền --base: devices=1, rate=6, duration=30 — và base KHÔNG có mặc định", () => {
  const result = parseArgs(withBase());
  assert.equal(result.ok, true);
  assert.equal(result.values.devices, 1);
  assert.equal(result.values.rate, 6);
  assert.equal(result.values.duration, 30);
  assert.equal(result.values.base, "http://127.0.0.1:39500");
});

test("parseArgs KHÔNG có --base trả lỗi và KHÔNG trả giá trị nào — không được tự nhắm vào cổng nào", () => {
  const result = parseArgs(["--devices", "3", "--duration", "10"]);
  assert.equal(result.ok, false);
  /* Trả values ở đây nghĩa là phía gọi có thể lỡ dùng chúng; phải là undefined. */
  assert.equal(result.values, undefined);
  assert.equal(result.error, MISSING_BASE_DEVICES);
  assert.match(result.error, /Thiếu --base/);
  // Không còn cổng mặc định nào được đề nghị dùng: 39117 chỉ được nhắc tới như sai lầm cũ.
  assert.match(result.error, /không còn cổng mặc định/i);
  assert.match(result.error, /--base http:\/\/127\.0\.0\.1:<39000-39999>/);
});

test("thông báo thiếu --base của bộ chạy kịch bản chỉ ra sandbox.js — lối thoát an toàn, không phải một cổng đoán mò", () => {
  assert.match(MISSING_BASE_SCENARIO, /sandbox\.js --server-entry/);
  assert.match(MISSING_BASE_SCENARIO, /run-scenario\.js <tên> --base/);
  // Giải thích VÌ SAO, để lần sau không ai đặt lại mặc định.
  assert.match(MISSING_BASE_SCENARIO, /39117/);
  assert.match(MISSING_BASE_SCENARIO, /39000–39999/);
});

test('parseArgs với --devices 500 trả lỗi nêu rõ khoảng 1..100 và KHÔNG trả giá trị đã kẹp', () => {
  const result = parseArgs(withBase("--devices", "500"));
  assert.equal(result.ok, false);
  assert.match(result.error, /--devices/);
  assert.match(result.error, /1\.\.100/);
  assert.match(result.error, /"500"/);
  // Kẹp im lặng về 100 là lỗi: người gõ lệnh sẽ đọc báo cáo của 100 máy tưởng là 500.
  assert.equal(result.values, undefined);
});

test('parseArgs với tham số lạ --xyz trả lỗi có chứa "--xyz"', () => {
  const result = parseArgs(withBase("--xyz", "7"));
  assert.equal(result.ok, false);
  assert.match(result.error, /--xyz/);
  assert.equal(result.values, undefined);
});

test("parseArgs nhận cả dạng --devices 5 lẫn --devices=5 và cho cùng kết quả", () => {
  const spaced = parseArgs(withBase("--devices", "5", "--rate", "12"));
  const equals = parseArgs(["--base=http://127.0.0.1:39500", "--devices=5", "--rate=12"]);
  assert.equal(spaced.ok, true);
  assert.equal(equals.ok, true);
  assert.equal(spaced.values.devices, 5);
  assert.equal(equals.values.devices, 5);
  assert.deepEqual(spaced.values, equals.values);
});

test("parseScenarioArgs lấy tên kịch bản từ tham số vị trí, để base=null khi không truyền, và báo lỗi khi thiếu tên", () => {
  const withName = parseScenarioArgs(["normal-10-devices", "--base", "http://127.0.0.1:39500"]);
  assert.equal(withName.ok, true);
  assert.equal(withName.values.scenario, "normal-10-devices");
  assert.equal(withName.values.base, "http://127.0.0.1:39500");

  /* base phải là null (chưa biết), KHÔNG phải một cổng đoán trước: run-scenario.js dựa vào
   * null này để in hướng dẫn và thoát 2 thay vì bắn tải vào một máy chủ nào đó. */
  const noBase = parseScenarioArgs(["normal-10-devices"]);
  assert.equal(noBase.ok, true);
  assert.equal(noBase.values.base, null);

  const missing = parseScenarioArgs(["--json"]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Thiếu tên kịch bản/);
});

test("isOutsideSimPortRange vẫn là lớp bảo vệ thứ hai: 3000/5173/8000 nằm ngoài dải, 39117 nằm trong", () => {
  assert.equal(isOutsideSimPortRange("http://127.0.0.1:3000"), true);
  assert.equal(isOutsideSimPortRange("http://127.0.0.1:5173"), true);
  assert.equal(isOutsideSimPortRange("http://127.0.0.1:8000"), true);
  /* Đúng cái lỗ hổng của F-16: 39117 nằm TRONG dải nên rào chắn này không bao giờ kêu.
   * Vì vậy lớp bảo vệ thứ nhất phải là "bắt buộc --base", không phải rào chắn cổng. */
  assert.equal(isOutsideSimPortRange("http://127.0.0.1:39117"), false);
});
