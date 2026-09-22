import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBackoffs, loadConfig } from "../src/config.js";

const DEFAULT_BACKOFFS = [5000, 15000, 60000, 60000];

/* Đặt biến môi trường rồi TRẢ LẠI nguyên trạng, kể cả khi assert ném giữa chừng: test khác
 * trong cùng tiến trình cũng đọc process.env. */
async function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("parseBackoffs: CSV hợp lệ giữ ĐÚNG THỨ TỰ và số phần tử đã ghi, có khoảng trắng thừa vẫn parse được", () => {
  assert.deepEqual(parseBackoffs("5000,15000"), [5000, 15000]);
  assert.deepEqual(parseBackoffs("5000,15000,60000,60000"), DEFAULT_BACKOFFS);
  assert.deepEqual(parseBackoffs(" 100 , 400 , 900 "), [100, 400, 900]);
  assert.deepEqual(parseBackoffs("7"), [7], "một phần tử vẫn là một bảng hợp lệ");
  assert.deepEqual(parseBackoffs("0,5000"), [0, 5000], "0 ms là giá trị hợp lệ (thử lại ngay)");
});

test("parseBackoffs: đầu vào xấu → loại phần tử xấu; không còn phần tử nào hợp lệ → bảng mặc định 5000/15000/60000/60000", () => {
  // Không phải chuỗi, hoặc chuỗi rỗng: không có gì để đọc.
  assert.deepEqual(parseBackoffs(undefined), DEFAULT_BACKOFFS);
  assert.deepEqual(parseBackoffs(null), DEFAULT_BACKOFFS);
  assert.deepEqual(parseBackoffs(""), DEFAULT_BACKOFFS);
  assert.deepEqual(parseBackoffs("   "), DEFAULT_BACKOFFS);
  assert.deepEqual(parseBackoffs(12345), DEFAULT_BACKOFFS, "số (không phải chuỗi) cũng về mặc định");

  // Toàn rác → mặc định, KHÔNG phải mảng rỗng: mảng rỗng làm worker thử lại tức thì vô hạn.
  assert.deepEqual(parseBackoffs("a,b"), DEFAULT_BACKOFFS);
  assert.deepEqual(parseBackoffs(",,,"), DEFAULT_BACKOFFS);
  assert.deepEqual(parseBackoffs("-1,-2"), DEFAULT_BACKOFFS);

  // Lẫn lộn: chỉ giữ số nguyên ≥ 0, giữ nguyên thứ tự các phần tử còn lại.
  assert.deepEqual(parseBackoffs("-1,5000"), [5000]);
  assert.deepEqual(parseBackoffs("5000,abc,15000"), [5000, 15000]);
  assert.deepEqual(parseBackoffs("1.5,200"), [200], "số thực không phải là mili-giây hợp lệ");
  assert.deepEqual(parseBackoffs("100,NaN,300"), [100, 300]);
});

test("parseBackoffs: mỗi lần gọi trả một mảng MỚI — sửa kết quả không làm hỏng bảng mặc định của lần gọi sau", () => {
  const first = parseBackoffs("");
  first.push(999999);
  first[0] = -1;
  assert.deepEqual(parseBackoffs(""), DEFAULT_BACKOFFS, "bảng mặc định phải bất biến giữa hai lần gọi");
  assert.notEqual(parseBackoffs(""), parseBackoffs(""), "hai lần gọi không được dùng chung một mảng");
});

test("loadConfig: OUTBOX_BACKOFF_MS của env đi thẳng vào config.outbox.backoffsMs (giữ thứ tự), env xấu → bảng mặc định", async () => {
  await withEnv({ OUTBOX_BACKOFF_MS: "100,400,900" }, () => {
    const cfg = loadConfig({ dotenv: false });
    assert.deepEqual(cfg.outbox.backoffsMs, [100, 400, 900]);
  });
  await withEnv({ OUTBOX_BACKOFF_MS: "khong-phai-so" }, () => {
    assert.deepEqual(loadConfig({ dotenv: false }).outbox.backoffsMs, DEFAULT_BACKOFFS);
  });
  await withEnv({ OUTBOX_BACKOFF_MS: undefined }, () => {
    assert.deepEqual(loadConfig({ dotenv: false }).outbox.backoffsMs, DEFAULT_BACKOFFS);
  });
});

test("loadConfig: TZ_OFFSET_MINUTES của env đi thẳng vào config.tzOffsetMinutes, nhận cả số ÂM, vắng mặt → 420", async () => {
  await withEnv({ TZ_OFFSET_MINUTES: "-300" }, () => {
    assert.equal(loadConfig({ dotenv: false }).tzOffsetMinutes, -300);
  });
  await withEnv({ TZ_OFFSET_MINUTES: "0" }, () => {
    assert.equal(loadConfig({ dotenv: false }).tzOffsetMinutes, 0, "0 (giờ UTC) phải đọc được, không bị nuốt thành 420");
  });
  await withEnv({ TZ_OFFSET_MINUTES: undefined }, () => {
    assert.equal(loadConfig({ dotenv: false }).tzOffsetMinutes, 420);
  });
  await withEnv({ TZ_OFFSET_MINUTES: "khong-phai-so" }, () => {
    assert.throws(() => loadConfig({ dotenv: false }), /TZ_OFFSET_MINUTES/, "cấu hình sai phải chặn khởi động, không im lặng dùng 420");
  });
});
