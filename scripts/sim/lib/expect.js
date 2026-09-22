/* Bộ chấm kỳ vọng — trái tim của "bài kiểm tra tự chấm".
 *
 * Luật sống chết của file này (05-virtual-devices.md §5):
 *   R1. Mỗi số đo có MỘT nguồn duy nhất, ghi rõ trong bảng CHECKS bên dưới. receipts.* luôn
 *       đọc từ MÁY CHỦ, không bao giờ từ bộ đếm của thiết bị ảo — chênh lệch giữa hai con số
 *       chính là thứ ta đi tìm (phiếu mất, phiếu trùng).
 *   R2. Mọi phép đếm là DELTA (cuối − đầu), không phải giá trị tuyệt đối: DB thử nghiệm luôn
 *       có sẵn dữ liệu cũ.
 *   R3. check lạ thì NÉM. Một kỳ vọng viết sai chính tả mà được bỏ qua im lặng sẽ biến cả
 *       kịch bản thành bài kiểm tra rỗng — vẫn "đạt", vẫn không kiểm được gì.
 */

import { COUNTER_NAMES } from "./fleet.js";

export const OPS = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
};

export const ORDERING_OPS = new Set([">", ">=", "<", "<="]);

/* Danh sách ĐÓNG các loại check. 15 dòng đầu là bảng hợp đồng §3.4 (save.* gộp 3 tên,
 * recognize.* gộp 2 tên, counter.* nhận một tên bộ đếm); 4 dòng cuối là phần bổ sung của
 * Phase 5 cho nhận dạng bất đồng bộ. Thêm dòng nào thì phải thêm cả nhánh đo ở measure(). */
export const CHECKS = [
  "receipts.delta",
  "receipts.byStatus",
  "requestId.unique",
  "save.p50Ms",
  "save.p95Ms",
  "save.maxMs",
  "recognize.p50Ms",
  "recognize.p95Ms",
  "counter", // dùng dạng counter.<tên>
  "queue.peakWaiting",
  "queue.peakInflight",
  "outbox.pendingEnd",
  "events.count",
  "recovery.ms",
  "status.backendEnd",
  /* Phase 5 — nhận dạng bất đồng bộ. Nguồn: GET /api/admin/recognitions (counts toàn bảng)
   * và GET /api/status.recognition.mode, cả hai đọc từ MÁY CHỦ. */
  "recognitions.delta",
  "recognitions.byStatus",
  "recognitions.pendingEnd",
  "status.recognitionMode",
];

/* Tổng số dòng recognitions từ counts {pending, completed, failed}. null khi không đọc được —
 * KHÔNG quy về 0: "không đo được" và "đo được 0" là hai kết luận khác hẳn nhau. */
function recognitionTotal(counts) {
  if (!counts || typeof counts !== "object") return null;
  let total = 0;
  for (const value of Object.values(counts)) {
    if (!Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

const NO_RECOGNITION_COUNTS = "GET /api/admin/recognitions không trả counts — không biết còn dòng nào treo hay không";

const DIRECT = new Set(CHECKS.filter((c) => c !== "counter"));

export class ExpectError extends Error {}

/** Nhãn hiển thị: "events.count type=recognition.failed", "counter.blocked", … */
export function describe(item) {
  if (item.label) return item.label;
  if (item.check === "events.count" && item.type) return `${item.check} type=${item.type}`;
  if (typeof item.check === "string" && item.check.endsWith(".byStatus") && item.status) return `${item.check} status=${item.status}`;
  return item.check;
}

function requireNumber(name, value) {
  if (!Number.isFinite(value)) throw new ExpectError(`${name}: không đo được (nguồn trả ${value})`);
  return value;
}

/**
 * Đo MỘT check từ ngữ cảnh. Ném ExpectError khi check không hiểu hoặc khai báo thiếu trường.
 * Trả { value } hoặc { value: null, reason } khi số liệu chưa có (endpoint chưa tồn tại…).
 */
export function measure(item, ctx) {
  const check = item?.check;
  if (typeof check !== "string" || check === "") throw new ExpectError("Mục expect thiếu trường check");

  if (check.startsWith("counter.")) {
    const name = check.slice("counter.".length);
    if (!COUNTER_NAMES.includes(name)) {
      throw new ExpectError(`check không hiểu: ${check} (bộ đếm hợp lệ: ${COUNTER_NAMES.join(", ")})`);
    }
    return { value: requireNumber(check, ctx.stats?.[name]) };
  }
  if (!DIRECT.has(check)) {
    throw new ExpectError(`check không hiểu: ${check} (hợp lệ: ${CHECKS.join(", ")})`);
  }

  const start = ctx.snapshots?.start ?? null;
  const end = ctx.snapshots?.end ?? null;

  switch (check) {
    case "receipts.delta": {
      if (!start || !end) return { value: null, reason: "thiếu ảnh chụp đầu hoặc cuối" };
      /* HIỆU, không phải trị tuyệt đối: delta âm nghĩa là phiếu BIẾN MẤT trong lúc chạy —
       * đó là phát hiện quan trọng nhất mà kịch bản có thể mang lại, không được giấu đi. */
      return { value: end.receiptsTotal - start.receiptsTotal };
    }
    case "receipts.byStatus": {
      if (typeof item.status !== "string" || item.status === "") {
        throw new ExpectError("check receipts.byStatus cần thêm trường status");
      }
      if (!start || !end) return { value: null, reason: "thiếu ảnh chụp đầu hoặc cuối" };
      return { value: (end.byStatus?.[item.status] ?? 0) - (start.byStatus?.[item.status] ?? 0) };
    }
    case "requestId.unique": {
      const dups = ctx.stats?.duplicateRequestIds ?? [];
      return { value: dups.length === 0, detail: dups.length > 0 ? `trùng: ${dups.join(", ")}` : null };
    }
    case "save.p50Ms":
      return { value: ctx.stats?.saveMs?.p50 ?? null, reason: "chưa có phiếu nào lưu thành công" };
    case "save.p95Ms":
      return { value: ctx.stats?.saveMs?.p95 ?? null, reason: "chưa có phiếu nào lưu thành công" };
    case "save.maxMs":
      return { value: ctx.stats?.saveMs?.max ?? null, reason: "chưa có phiếu nào lưu thành công" };
    case "recognize.p50Ms":
      return { value: ctx.stats?.recognizeMs?.p50 ?? null, reason: "chưa có lần nhận dạng nào xong" };
    case "recognize.p95Ms":
      return { value: ctx.stats?.recognizeMs?.p95 ?? null, reason: "chưa có lần nhận dạng nào xong" };
    case "queue.peakWaiting":
      return { value: requireNumber(check, ctx.peaks?.waiting) };
    case "queue.peakInflight":
      return { value: requireNumber(check, ctx.peaks?.inflight) };
    case "outbox.pendingEnd": {
      if (!end) return { value: null, reason: "thiếu ảnh chụp cuối" };
      return { value: requireNumber(check, end.outboxPending) };
    }
    case "events.count": {
      if (typeof item.type !== "string" || item.type === "") {
        throw new ExpectError("check events.count cần thêm trường type");
      }
      if (!ctx.eventsAvailable) {
        return { value: null, reason: "GET /api/admin/events chưa có — khai báo requires:[\"events\"] để kịch bản tự SKIP" };
      }
      const events = Array.isArray(ctx.events) ? ctx.events : [];
      return { value: events.filter((e) => e?.type === item.type).length };
    }
    case "recovery.ms": {
      if (ctx.recoveryMs === null || ctx.recoveryMs === undefined) {
        return { value: null, reason: "không có bước sim.clear, hoặc không có phiếu nào lưu được sau đó" };
      }
      return { value: ctx.recoveryMs };
    }
    case "status.backendEnd": {
      if (!end) return { value: null, reason: "thiếu ảnh chụp cuối" };
      return { value: end.backendState ?? null, reason: "không đọc được /api/status lúc kết thúc" };
    }
    case "recognitions.delta": {
      if (!start || !end) return { value: null, reason: "thiếu ảnh chụp đầu hoặc cuối" };
      const before = recognitionTotal(start.recognitionCounts);
      const after = recognitionTotal(end.recognitionCounts);
      if (before === null || after === null) return { value: null, reason: NO_RECOGNITION_COUNTS };
      return { value: after - before };
    }
    case "recognitions.byStatus": {
      if (typeof item.status !== "string" || item.status === "") {
        throw new ExpectError("check recognitions.byStatus cần thêm trường status");
      }
      if (!start || !end) return { value: null, reason: "thiếu ảnh chụp đầu hoặc cuối" };
      if (!start.recognitionCounts || !end.recognitionCounts) return { value: null, reason: NO_RECOGNITION_COUNTS };
      return { value: (end.recognitionCounts[item.status] ?? 0) - (start.recognitionCounts[item.status] ?? 0) };
    }
    case "recognitions.pendingEnd": {
      /* TRỊ TUYỆT ĐỐI chứ không phải delta — đúng như outbox.pendingEnd. Câu hỏi ở đây không
       * phải "có thêm bao nhiêu dòng treo" mà "sau khi mọi thứ đã lắng, còn dòng nào treo
       * không". Một dòng `pending` sót lại là một PDA đứng mãi ở «Đang đọc nhãn…». */
      if (!end) return { value: null, reason: "thiếu ảnh chụp cuối" };
      if (!end.recognitionCounts) return { value: null, reason: NO_RECOGNITION_COUNTS };
      return { value: requireNumber(check, end.recognitionCounts.pending) };
    }
    case "status.recognitionMode": {
      if (!end) return { value: null, reason: "thiếu ảnh chụp cuối" };
      return { value: end.recognitionMode ?? null, reason: "GET /api/status không trả recognition.mode" };
    }
    default:
      throw new ExpectError(`check không hiểu: ${check}`);
  }
}

/**
 * Kiểm khai báo MỘT mục expect mà KHÔNG cần số liệu. Gọi lúc nạp file kịch bản để một chữ
 * viết sai bị bắt ngay, thay vì sau 90 giây chạy — và để nó không bao giờ có cơ hội "đạt"
 * chỉ vì không ai đo nó.
 */
export function validateExpectation(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new ExpectError("Mục expect phải là object");
  const check = item.check;
  if (typeof check !== "string" || check === "") throw new ExpectError("Mục expect thiếu trường check");
  if (check.startsWith("counter.")) {
    const name = check.slice("counter.".length);
    if (!COUNTER_NAMES.includes(name)) {
      throw new ExpectError(`check không hiểu: ${check} (bộ đếm hợp lệ: ${COUNTER_NAMES.join(", ")})`);
    }
  } else if (!DIRECT.has(check)) {
    throw new ExpectError(`check không hiểu: ${check} (hợp lệ: ${CHECKS.join(", ")})`);
  }
  if (!(item.op in OPS)) throw new ExpectError(`op không hiểu: ${item.op} (hợp lệ: ${Object.keys(OPS).join(" ")})`);
  if (item.value === undefined) throw new ExpectError(`Mục expect "${describe(item)}" thiếu trường value`);
  if (check === "events.count" && (typeof item.type !== "string" || item.type === "")) {
    throw new ExpectError("check events.count cần thêm trường type");
  }
  if (check.endsWith(".byStatus") && (typeof item.status !== "string" || item.status === "")) {
    throw new ExpectError(`check ${check} cần thêm trường status`);
  }
  return true;
}

/** Chấm MỘT mục expect. Ném ExpectError khi khai báo sai; không bao giờ nuốt lỗi. */
export function evaluate(item, ctx) {
  const op = item?.op;
  if (!(op in OPS)) {
    throw new ExpectError(`op không hiểu: ${op} (hợp lệ: ${Object.keys(OPS).join(" ")})`);
  }
  if (item.value === undefined) throw new ExpectError(`Mục expect "${describe(item)}" thiếu trường value`);

  const label = describe(item);
  const out = measure(item, ctx);
  const measured = out.value;

  if (measured === null || measured === undefined) {
    return { check: item.check, label, measured: null, op, value: item.value, passed: false, reason: out.reason ?? "không đo được" };
  }
  if (ORDERING_OPS.has(op) && typeof measured !== "number") {
    throw new ExpectError(`Mục "${label}": toán tử ${op} không dùng được với giá trị kiểu ${typeof measured}`);
  }
  const passed = OPS[op](measured, item.value);
  return {
    check: item.check,
    label,
    measured,
    op,
    value: item.value,
    passed,
    reason: passed ? null : (out.detail ?? null),
  };
}

/**
 * Chấm cả danh sách. `extra` là các mục expectNow đã chấm trước đó (chúng đã đo tại thời điểm
 * của mình nên không chấm lại ở cuối).
 */
export function runExpectations(items, ctx, extra = []) {
  if (!Array.isArray(items)) throw new ExpectError("expect phải là một mảng");
  const results = [...extra, ...items.map((item) => evaluate(item, ctx))];
  const failed = results.filter((r) => !r.passed);
  return { passed: failed.length === 0, results, failed, total: results.length, passedCount: results.length - failed.length };
}
