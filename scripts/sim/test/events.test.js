import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, FIXED_EVENT_TYPES, RECEIPT_EVENT_TYPES, isKnownEventType } from "../lib/events.js";

/* Bảng đăng ký chép TAY từ docs/specs/phase-5/02-contracts-api.md §4.3, không import từ
 * lib/events.js — nếu cả hai cùng lấy từ một nguồn thì test này không kiểm được gì. */
const REGISTRY_FROM_CONTRACT = [
  "server.start",
  "server.stop",
  "sim.updated",
  "sim.cleared",
  "device.registered",
  "device.camera_error",
  "device.battery_low",
  "device.queue_enqueued",
  "device.queue_synced",
  "device.sim_changed",
  "session.started",
  "session.ended",
  "recognition.started",
  "recognition.completed",
  "recognition.failed",
  "recognition.rejected_busy",
  "receipt.confirmed",
  "receipt.duplicate_override",
  "receipt.posting",
  "receipt.posted",
  "receipt.post_retry",
  "receipt.post_failed",
  "receipt.rejected",
  "receipt.retry_requested",
  "receipt.cancelled",
  "receipt.reversal_queued",
  "receipt.reversal_posted",
  "receipt.reversal_failed",
  "receipt.corrected",
  "receipt.superseded",
  "receipt.swept",
];

test("bảng EVENT_TYPES của scripts/sim có đúng 31 loại, khớp bảng đăng ký của 02-contracts-api.md §4.3", () => {
  assert.equal(REGISTRY_FROM_CONTRACT.length, 31);
  assert.equal(EVENT_TYPES.length, 31);
  assert.deepEqual([...EVENT_TYPES].sort(), [...REGISTRY_FROM_CONTRACT].sort());
  assert.equal(FIXED_EVENT_TYPES.length, 16);
  assert.equal(RECEIPT_EVENT_TYPES.length, 15);
  assert.equal(new Set(EVENT_TYPES).size, 31, "không được có loại trùng");
});

test("isKnownEventType nhận loại có trong bảng và từ chối loại gõ sai", () => {
  assert.equal(isKnownEventType("recognition.failed"), true);
  assert.equal(isKnownEventType("receipt.post_retry"), true);
  assert.equal(isKnownEventType("recognition.fail"), false);
  assert.equal(isKnownEventType("receipt.posted_retry"), false);
});
