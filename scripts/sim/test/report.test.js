import test from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../lib/report.js";

const stats = {
  saved: 48,
  idempotent: 0,
  duplicate: 0,
  invalid: 0,
  invalidLocation: 0,
  busy429: 0,
  blocked: 0,
  netError: 0,
  otherError: 0,
  saveFailed: 0,
  recognizeOk: 0,
  recognizeFailed: 0,
  heartbeats: 4,
  saveMs: { p50: 42, p95: 118, min: 20, max: 240, n: 48 },
  recognizeMs: { p50: null, p95: null, min: null, max: null, n: 0 },
  duplicateRequestIds: [],
  notes: [],
  problems: [],
};

const scenarioData = (expectations) => ({
  kind: "scenario",
  name: "normal-10-devices",
  description: "đường cơ sở",
  baseUrl: "http://127.0.0.1:39117",
  startedAt: Date.UTC(2026, 8, 22, 3, 20, 11),
  elapsedMs: 68_300,
  log: [{ tMs: 0, text: "devices.start 10 thiết bị" }],
  stats,
  byStatus: { confirmed: 0, posting: 2, posted: 46, post_failed: 0 },
  expectations,
});

test('renderReport in đúng chuỗi "KẾT QUẢ:  ĐẠT" khi mọi kỳ vọng đạt', () => {
  const text = renderReport(
    scenarioData({
      passed: true,
      total: 2,
      passedCount: 2,
      failed: [],
      results: [
        { check: "receipts.delta", label: "receipts.delta", measured: 60, op: ">=", value: 50, passed: true },
        { check: "counter.netError", label: "counter.netError", measured: 0, op: "==", value: 0, passed: true },
      ],
    }),
  );
  assert.ok(text.includes("KẾT QUẢ:  ĐẠT"), text);
  assert.ok(text.includes("(2/2 kỳ vọng)"), text);
  assert.ok(!text.includes("KHÔNG ĐẠT"), text);
  assert.ok(!text.includes("Không đạt:"), text);
});

test('renderReport in "KẾT QUẢ:  KHÔNG ĐẠT" kèm dòng liệt kê từng mục hỏng', () => {
  const failed = [{ check: "receipts.delta", label: "receipts.delta", measured: 2, op: ">=", value: 6, passed: false, reason: null }];
  const text = renderReport(
    scenarioData({
      passed: false,
      total: 2,
      passedCount: 1,
      failed,
      results: [
        ...failed,
        { check: "counter.netError", label: "counter.netError", measured: 0, op: "==", value: 0, passed: true },
      ],
    }),
  );
  assert.ok(text.includes("KẾT QUẢ:  KHÔNG ĐẠT"), text);
  assert.ok(text.includes("(1/2 kỳ vọng)"), text);
  // Người đọc không nên phải cuộn ngược lên tìm mục nào hỏng.
  assert.ok(text.includes("Không đạt: receipts.delta (đo 2, cần >= 6)"), text);
});

test("renderReport với --json in đúng MỘT dòng JSON parse được và có đủ khoá saved, byStatus, saveMs", () => {
  const text = renderReport(scenarioData({ passed: true, total: 1, passedCount: 1, failed: [], results: [] }), { json: true });
  assert.equal(text.split("\n").length, 1);
  const parsed = JSON.parse(text);
  assert.equal(parsed.saved, 48);
  assert.deepEqual(parsed.byStatus, { confirmed: 0, posting: 2, posted: 46, post_failed: 0 });
  assert.deepEqual(parsed.saveMs, { p50: 42, p95: 118, min: 20, max: 240, n: 48 });
  assert.equal(parsed.verdict, "ĐẠT");
});

test("renderReport in SKIPPED kèm lý do khi kịch bản bị bỏ qua và không in kết quả chấm", () => {
  const text = renderReport({ ...scenarioData(null), skipped: "endpoint chưa có: /api/admin/events" });
  assert.ok(text.includes("SKIPPED (endpoint chưa có: /api/admin/events)"), text);
  assert.ok(!text.includes("KẾT QUẢ:"), text);
});
