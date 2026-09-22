import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, measure, runExpectations, validateExpectation, ExpectError } from "../lib/expect.js";

const baseCtx = (over = {}) => ({
  snapshots: {
    start: {
      receiptsTotal: 10,
      byStatus: { posted: 2 },
      outboxPending: 0,
      backendState: "up",
      recognitionCounts: { pending: 0, completed: 4, failed: 1 },
      recognitionMode: "async",
    },
    end: {
      receiptsTotal: 22,
      byStatus: { posted: 9 },
      outboxPending: 0,
      backendState: "up",
      recognitionCounts: { pending: 0, completed: 19, failed: 7 },
      recognitionMode: "async",
    },
  },
  stats: {
    saved: 5,
    blocked: 0,
    netError: 0,
    otherError: 0,
    busy429: 0,
    duplicateRequestIds: [],
    saveMs: { p50: 40, p95: 120, min: 10, max: 300, n: 12 },
    recognizeMs: { p50: null, p95: null, min: null, max: null, n: 0 },
  },
  peaks: { waiting: 7, inflight: 3 },
  events: [],
  eventsAvailable: true,
  recoveryMs: 4120,
  ...over,
});

test("evaluate so sánh đúng cả 6 toán tử ==, !=, >, >=, <, <= trên cùng một cặp số", () => {
  const ctx = baseCtx(); // counter.saved = 5, so với ngưỡng 5
  const verdict = (op) => evaluate({ check: "counter.saved", op, value: 5 }, ctx).passed;
  assert.equal(verdict("=="), true);
  assert.equal(verdict("!="), false);
  assert.equal(verdict(">"), false);
  assert.equal(verdict(">="), true);
  assert.equal(verdict("<"), false);
  assert.equal(verdict("<="), true);
});

test("evaluate với check ngoài danh sách 12 loại NÉM lỗi nêu tên check sai", () => {
  assert.throws(() => evaluate({ check: "receipts.deltaa", op: ">=", value: 1 }, baseCtx()), (err) => {
    assert.ok(err instanceof ExpectError);
    assert.match(err.message, /receipts\.deltaa/);
    return true;
  });
  // Bộ đếm gõ sai cũng phải ném, không được lặng lẽ trả 0 rồi "đạt".
  assert.throws(() => evaluate({ check: "counter.blockd", op: ">=", value: 1 }, baseCtx()), /counter\.blockd/);
  assert.throws(() => validateExpectation({ check: "queue.peakWating", op: ">=", value: 1 }), /queue\.peakWating/);
});

test('evaluate check "receipts.delta" lấy hiệu giữa ảnh chụp cuối và ảnh chụp đầu, KHÔNG lấy giá trị tuyệt đối', () => {
  const grew = evaluate({ check: "receipts.delta", op: ">=", value: 12 }, baseCtx());
  assert.equal(grew.measured, 12); // 22 − 10

  /* Phiếu BIẾN MẤT: cuối 4, đầu 10 → delta phải là −6. Nếu ở đây trả 6 thì một lần mất phiếu
   * sẽ được báo cáo là một lần lưu thành công — lỗi nguy hiểm nhất mà bộ chạy có thể mắc. */
  const shrank = evaluate(
    { check: "receipts.delta", op: ">=", value: 1 },
    baseCtx({
      snapshots: {
        start: { receiptsTotal: 10, byStatus: {}, outboxPending: 0, backendState: "up" },
        end: { receiptsTotal: 4, byStatus: {}, outboxPending: 0, backendState: "up" },
      },
    }),
  );
  assert.equal(shrank.measured, -6);
  assert.equal(shrank.passed, false);
});

test('evaluate check "requestId.unique" trả false khi danh sách requestId có phần tử lặp', () => {
  const clean = evaluate({ check: "requestId.unique", op: "==", value: true }, baseCtx());
  assert.equal(clean.measured, true);
  assert.equal(clean.passed, true);

  const ctx = baseCtx();
  const dirty = evaluate(
    { check: "requestId.unique", op: "==", value: true },
    { ...ctx, stats: { ...ctx.stats, duplicateRequestIds: ["r-1", "r-9"] } },
  );
  assert.equal(dirty.measured, false);
  assert.equal(dirty.passed, false);
  assert.match(dirty.reason, /r-1/);
});

test('evaluate check "events.count" đếm đúng số phần tử có type khớp và bỏ qua type khác', () => {
  const events = [
    { id: 1, type: "recognition.failed" },
    { id: 2, type: "recognition.completed" },
    { id: 3, type: "recognition.failed" },
    { id: 4, type: "receipt.posted" },
    { id: 5, type: "recognition.failed" },
  ];
  const result = evaluate({ check: "events.count", type: "recognition.failed", op: ">=", value: 1 }, baseCtx({ events }));
  assert.equal(result.measured, 3);
  assert.equal(result.passed, true);
  assert.equal(result.label, "events.count type=recognition.failed");

  const other = measure({ check: "events.count", type: "receipt.posted" }, baseCtx({ events }));
  assert.equal(other.value, 1);
});

test("runExpectations trả passed=false và liệt kê đúng tên những mục không đạt", () => {
  const ctx = baseCtx();
  const items = [
    { check: "receipts.delta", op: ">=", value: 12 }, // đo 12 → đạt
    { check: "counter.netError", op: "==", value: 0 }, // đo 0 → đạt
    { check: "save.p95Ms", op: "<", value: 100 }, // đo 120 → KHÔNG đạt
    { check: "queue.peakInflight", op: "<=", value: 2 }, // đo 3 → KHÔNG đạt
  ];
  const out = runExpectations(items, ctx);
  assert.equal(out.passed, false);
  assert.equal(out.total, 4);
  assert.equal(out.passedCount, 2);
  assert.deepEqual(
    out.failed.map((r) => r.label),
    ["save.p95Ms", "queue.peakInflight"],
  );
  assert.deepEqual(
    out.failed.map((r) => r.measured),
    [120, 3],
  );
});

/* ---------- Phase 5: nhận dạng bất đồng bộ ------------------------------------------------ */

const withRecognitions = (startCounts, endCounts) => {
  const ctx = baseCtx();
  return {
    ...ctx,
    snapshots: {
      start: { ...ctx.snapshots.start, recognitionCounts: startCounts },
      end: { ...ctx.snapshots.end, recognitionCounts: endCounts },
    },
  };
};

test('check "recognitions.pendingEnd" đo số dòng còn treo lúc KẾT THÚC, không phải hiệu — một job kẹt làm kỳ vọng đỏ', () => {
  const clean = evaluate({ check: "recognitions.pendingEnd", op: "==", value: 0 }, baseCtx());
  assert.equal(clean.measured, 0);
  assert.equal(clean.passed, true);

  /* Đúng tình huống F-01: chạy xong, đã lắng, mà vẫn còn 1 dòng `pending`. PDA của người dùng
   * đang đứng ở «Đang đọc nhãn…». Kịch bản PHẢI đỏ. */
  const stuck = evaluate(
    { check: "recognitions.pendingEnd", op: "==", value: 0 },
    withRecognitions({ pending: 0, completed: 4, failed: 1 }, { pending: 1, completed: 19, failed: 7 }),
  );
  assert.equal(stuck.measured, 1);
  assert.equal(stuck.passed, false);

  /* Trị TUYỆT ĐỐI, không phải delta: một dòng treo có từ trước lần chạy này vẫn là một dòng
   * treo. Lấy hiệu ở đây (1 − 1 = 0) sẽ giấu mất nó. */
  const alreadyStuck = evaluate(
    { check: "recognitions.pendingEnd", op: "==", value: 0 },
    withRecognitions({ pending: 1, completed: 4, failed: 1 }, { pending: 1, completed: 19, failed: 7 }),
  );
  assert.equal(alreadyStuck.measured, 1);
  assert.equal(alreadyStuck.passed, false);
});

test('check "recognitions.pendingEnd" báo KHÔNG ĐO ĐƯỢC khi máy chủ không trả counts, thay vì coi như bằng 0', () => {
  const blind = evaluate({ check: "recognitions.pendingEnd", op: "==", value: 0 }, withRecognitions(null, null));
  assert.equal(blind.measured, null);
  assert.equal(blind.passed, false, "không đọc được số job treo mà vẫn ĐẠT là bài kiểm tra rỗng");
  assert.match(blind.reason, /không biết còn dòng nào treo/);
});

test('check "recognitions.delta" và "recognitions.byStatus" lấy HIỆU giữa hai ảnh chụp, tách theo từng trạng thái', () => {
  const total = evaluate({ check: "recognitions.delta", op: ">=", value: 20 }, baseCtx());
  assert.equal(total.measured, 21); // (0+19+7) − (0+4+1)
  assert.equal(total.passed, true);

  const completed = evaluate({ check: "recognitions.byStatus", status: "completed", op: ">=", value: 8 }, baseCtx());
  assert.equal(completed.measured, 15); // 19 − 4
  assert.equal(completed.label, "recognitions.byStatus status=completed");

  /* Nhánh "chờ quá hạn" của chế độ async phải kết ở `failed`. Đúng 0 dòng failed nghĩa là
   * nhánh đó chưa bao giờ được đi qua — kịch bản tưởng mình đã kiểm, thật ra thì không. */
  const failed = evaluate(
    { check: "recognitions.byStatus", status: "failed", op: ">=", value: 1 },
    withRecognitions({ pending: 0, completed: 4, failed: 1 }, { pending: 0, completed: 19, failed: 1 }),
  );
  assert.equal(failed.measured, 0);
  assert.equal(failed.passed, false);
});

test('check "recognitions.byStatus" thiếu trường status bị chặn NGAY LÚC NẠP, không đợi chạy xong', () => {
  assert.throws(() => validateExpectation({ check: "recognitions.byStatus", op: ">=", value: 1 }), /cần thêm trường status/);
  assert.throws(() => measure({ check: "recognitions.byStatus", op: ">=", value: 1 }, baseCtx()), ExpectError);
});

test('check "status.recognitionMode" đọc chế độ THẬT của máy chủ: kịch bản async chạy nhầm vào máy chủ sync phải đỏ', () => {
  const ok = evaluate({ check: "status.recognitionMode", op: "==", value: "async" }, baseCtx());
  assert.equal(ok.measured, "async");
  assert.equal(ok.passed, true);

  const ctx = baseCtx();
  const fellBack = evaluate(
    { check: "status.recognitionMode", op: "==", value: "async" },
    { ...ctx, snapshots: { ...ctx.snapshots, end: { ...ctx.snapshots.end, recognitionMode: "sync" } } },
  );
  assert.equal(fellBack.measured, "sync");
  assert.equal(fellBack.passed, false);
});
