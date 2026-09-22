import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listScenarios, loadScenario, validateScenario, serverEnvMismatch, ScenarioError, ACTIONS } from "../run-scenario.js";

const CANARIES = {
  "normal-10-devices": { check: "receipts.delta", op: ">=", value: 50 },
  "ocr-slow-then-recover": { check: "events.count", type: "recognition.failed", op: ">=", value: 1 },
  "backend-down-30s": { check: "counter.blocked", op: ">=", value: 5 },
  "sap-down-then-recover": { check: "events.count", type: "receipt.post_retry", op: ">=", value: 1 },
  "overload-20-uploads": { check: "counter.busy429", op: ">=", value: 1 },
  /* Canary của kịch bản async: một job kẹt `pending` (lỗi F-01) làm nó đỏ ngay. Gỡ dòng này
   * là gỡ mất thứ DUY NHẤT phát hiện "PDA treo ở Đang đọc nhãn…" trong cả bộ kịch bản. */
  "async-recognition-no-stuck-jobs": { check: "recognitions.pendingEnd", op: "==", value: 0 },
};

test("thư mục scenarios có đúng 6 kịch bản mẫu bắt buộc và cả 6 đều nạp được", () => {
  assert.deepEqual(listScenarios(), Object.keys(CANARIES).sort());
  for (const name of listScenarios()) {
    const scenario = loadScenario(name);
    assert.equal(scenario.name, name, "trường name phải khớp tên file");
    assert.ok(scenario.steps.length > 0);
    assert.ok(scenario.expect.length > 0);
  }
});

test("mỗi kịch bản mẫu giữ đúng kỳ vọng canary của nó — thứ sẽ đỏ khi tính năng đang kiểm bị gỡ", () => {
  for (const [name, canary] of Object.entries(CANARIES)) {
    const scenario = loadScenario(name);
    const found = scenario.expect.find(
      (e) => e.check === canary.check && e.op === canary.op && e.value === canary.value && (canary.type ? e.type === canary.type : true),
    );
    assert.ok(found, `kịch bản ${name} mất kỳ vọng canary ${canary.check} ${canary.op} ${canary.value}`);
  }
});

test("không kịch bản mẫu nào chứa kỳ vọng luôn-đúng kiểu '>= 0' trên một phép đếm", () => {
  for (const name of listScenarios()) {
    for (const item of loadScenario(name).expect) {
      const counting =
        item.check.startsWith("counter.") ||
        item.check === "receipts.delta" ||
        item.check === "events.count" ||
        item.check === "recognitions.delta" ||
        item.check === "recognitions.byStatus";
      assert.ok(
        !(counting && item.op === ">=" && item.value === 0),
        `${name}: "${item.check} >= 0" luôn đúng nên không kiểm được gì`,
      );
    }
  }
});

test("không kịch bản mẫu nào dùng action nằm ngoài danh sách 8 giá trị, và không action nào giết tiến trình", () => {
  for (const name of listScenarios()) {
    for (const step of loadScenario(name).steps) {
      assert.ok(ACTIONS.includes(step.action), `${name}: action lạ ${step.action}`);
    }
  }
  assert.equal(ACTIONS.length, 8);
  assert.equal(
    ACTIONS.some((a) => /kill|stopProcess|signal/i.test(a)),
    false,
    "danh sách action không được chứa hành động giết tiến trình",
  );
});

test("đúng một kịch bản mẫu chạy chế độ nhận dạng async, và nó khẳng định cả ba điều: mode=async, có 202+thăm dò, không dòng nào treo", () => {
  const async = listScenarios()
    .map((name) => loadScenario(name))
    .filter((s) => s.serverEnv?.RECOGNITION_MODE === "async");
  assert.equal(async.length, 1, "phải có đúng một kịch bản chạy async");
  const scenario = async[0];

  const has = (check, extra = {}) =>
    scenario.expect.some((e) => e.check === check && Object.entries(extra).every(([k, v]) => e[k] === v));

  // (b) đường 202 + thăm dò phải THẬT SỰ được đi qua, không âm thầm rơi về sync.
  assert.ok(has("status.recognitionMode"), "thiếu kỳ vọng status.recognitionMode");
  assert.ok(has("counter.recognizeAccepted202"), "thiếu kỳ vọng counter.recognizeAccepted202");
  assert.ok(has("counter.recognizePolls"), "thiếu kỳ vọng counter.recognizePolls");
  // (a) mọi dòng nhận dạng phải kết thúc dứt khoát.
  assert.ok(has("recognitions.pendingEnd"), "thiếu kỳ vọng recognitions.pendingEnd");
  assert.ok(has("recognitions.byStatus", { status: "failed" }), "thiếu kỳ vọng số dòng failed");
  assert.ok(has("recognitions.byStatus", { status: "completed" }), "thiếu kỳ vọng số dòng completed");

  const pending = scenario.expect.find((e) => e.check === "recognitions.pendingEnd");
  assert.equal(pending.op, "==");
  assert.equal(pending.value, 0, "pendingEnd phải là == 0: >= 0 luôn đúng nên không kiểm được gì");
});

test("serverEnvMismatch bắt được máy chủ sai chế độ NGAY ở pha tiền kiểm, và im lặng khi khớp", () => {
  const scenario = { name: "k", serverEnv: { RECOGNITION_MODE: "async", RECOGNITION_MAX_CONCURRENT: "2" } };
  const asyncStatus = { recognition: { mode: "async", maxConcurrent: 2, maxWaiting: 12 } };
  assert.equal(serverEnvMismatch(scenario, asyncStatus), null);

  const syncStatus = { recognition: { mode: "sync", maxConcurrent: 2 } };
  const message = serverEnvMismatch(scenario, syncStatus);
  assert.match(message, /RECOGNITION_MODE=async/);
  assert.match(message, /RECOGNITION_MODE=sync/);
  assert.match(message, /sandbox\.js/);

  // Số đọc từ /api/status là số, giá trị trong serverEnv là chuỗi: so sánh phải chịu được cả hai.
  assert.equal(serverEnvMismatch({ name: "k", serverEnv: { RECOGNITION_MAX_CONCURRENT: "2" } }, asyncStatus), null);
  assert.match(serverEnvMismatch({ name: "k", serverEnv: { RECOGNITION_MAX_CONCURRENT: "5" } }, asyncStatus), /maxConcurrent|RECOGNITION_MAX_CONCURRENT/);

  // Kịch bản không đòi gì thì không chặn gì.
  assert.equal(serverEnvMismatch({ name: "k" }, syncStatus), null);
});

test("validateScenario từ chối serverEnv sai kiểu thay vì lặng lẽ dựng máy chủ ở cấu hình mặc định", () => {
  const base = { name: "x", steps: [{ at: 0, action: "note", text: "a" }], expect: [{ check: "receipts.delta", op: ">=", value: 1 }] };
  assert.throws(() => validateScenario({ ...base, serverEnv: ["RECOGNITION_MODE=async"] }), /serverEnv phải là object/);
  assert.throws(() => validateScenario({ ...base, serverEnv: { RECOGNITION_MAX_CONCURRENT: 2 } }), /phải là chuỗi, nhận number/);
  assert.throws(() => validateScenario({ ...base, serverEnv: { "recognition-mode": "async" } }), /tên biến môi trường không hợp lệ/);
  // Khai đúng thì đi qua.
  assert.equal(validateScenario({ ...base, serverEnv: { RECOGNITION_MODE: "async" } }).serverEnv.RECOGNITION_MODE, "async");
});

test("validateScenario từ chối kịch bản có expect rỗng vì nó không kiểm được gì", () => {
  assert.throws(
    () => validateScenario({ name: "x", steps: [{ at: 0, action: "note", text: "hi" }], expect: [] }),
    (err) => {
      assert.ok(err instanceof ScenarioError);
      assert.match(err.message, /không có kỳ vọng nào/);
      return true;
    },
  );
});

test("validateScenario từ chối action lạ, mốc at giảm dần, và trường bắt buộc bị thiếu", () => {
  const ok = [{ check: "receipts.delta", op: ">=", value: 1 }];
  assert.throws(() => validateScenario({ name: "x", steps: [{ at: 0, action: "kill" }], expect: ok }), /action không hiểu: kill/);
  assert.throws(
    () =>
      validateScenario({
        name: "x",
        steps: [
          { at: 5000, action: "note", text: "a" },
          { at: 1000, action: "note", text: "b" },
        ],
        expect: ok,
      }),
    /nhỏ hơn bước trước/,
  );
  assert.throws(() => validateScenario({ name: "x", expect: ok }), /thiếu trường bắt buộc: steps/);
  assert.throws(() => validateScenario({ steps: [], expect: ok }), /thiếu trường bắt buộc: name/);
});

test("validateScenario từ chối check gõ sai trong expect NGAY LÚC NẠP, không đợi chạy xong mới biết", () => {
  assert.throws(
    () => validateScenario({ name: "x", steps: [{ at: 0, action: "note", text: "a" }], expect: [{ check: "receipt.delta", op: ">=", value: 1 }] }),
    /check không hiểu: receipt\.delta/,
  );
  assert.throws(
    () => validateScenario({ name: "x", steps: [{ at: 0, action: "note", text: "a" }], expect: [{ check: "events.count", op: ">=", value: 1 }] }),
    /events\.count cần thêm trường type/,
  );
});

test("loadScenario đọc được kịch bản theo đường dẫn tuyệt đối và báo lỗi rõ khi file không tồn tại", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-sim-test-"));
  const file = path.join(dir, "tam.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      name: "tuỳ-ý",
      steps: [{ at: 0, action: "note", text: "xin chào" }],
      expect: [{ check: "receipts.delta", op: ">=", value: 1 }],
    }),
  );
  try {
    const scenario = loadScenario(file);
    assert.equal(scenario.name, "tuỳ-ý"); // theo đường dẫn thì KHÔNG bắt name khớp tên file
    assert.throws(() => loadScenario(path.join(dir, "khong-co.json")), /Không tìm thấy kịch bản/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
