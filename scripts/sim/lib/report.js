/* In báo cáo — bảng cho người đọc, JSON một dòng cho máy đọc.
 *
 * Module này KHÔNG quyết định mã thoát. Nó nhận kết quả đã chấm và vẽ lại. Để nó vừa vẽ vừa
 * quyết thì một lần sửa định dạng có thể lặng lẽ đổi kết quả nghiệm thu.
 *
 * Ba chuỗi dưới đây là HỢP ĐỒNG, có test khoá: "ĐẠT", "KHÔNG ĐẠT", "SKIPPED".
 */

export const VERDICT_PASS = "ĐẠT";
export const VERDICT_FAIL = "KHÔNG ĐẠT";
export const VERDICT_SKIP = "SKIPPED";

/* Bản chép thứ tự 8 trạng thái phiếu của Phase 4 — dùng để bảng luôn in đủ 8 ô, kể cả ô 0.
 * Ô vắng mặt và ô bằng 0 là hai chuyện khác nhau với người đang đọc báo cáo. */
export const RECEIPT_STATUSES = [
  "confirmed",
  "posting",
  "posted",
  "post_failed",
  "rejected",
  "cancelled",
  "corrected",
  "superseded",
];

const WIDE = "═".repeat(68);
const THIN = "─".repeat(68);

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const clock = (d) => new Date(d).toTimeString().slice(0, 8);
const padEnd = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);
const showValue = (v) => (v === null || v === undefined ? "—" : typeof v === "boolean" ? String(v) : String(v));

function msLine(label, s) {
  if (!s || s.n === 0) return ` ${padEnd(label, 24)} p50 —     p95 —     max —     n=0`;
  return ` ${padEnd(label, 24)} p50 ${padEnd(s.p50, 5)} p95 ${padEnd(s.p95, 5)} max ${padEnd(s.max, 5)} n=${s.n}`;
}

function statusLines(byStatus) {
  const b = byStatus ?? {};
  const cell = (k) => `${k} ${b[k] ?? 0}`;
  const first = RECEIPT_STATUSES.slice(0, 4).map(cell).join(" · ");
  const second = RECEIPT_STATUSES.slice(4).map(cell).join(" · ");
  return [` Phiếu theo trạng thái  ${first}`, `                        ${second}`];
}

function expectationRows(results) {
  const out = [` ${padEnd("KỲ VỌNG", 42)}${padStart("ĐO ĐƯỢC", 9)}   ${padEnd("NGƯỠNG", 9)} KẾT QUẢ`];
  for (const r of results) {
    const at = r.atMs === undefined || r.atMs === null ? "" : ` @${secs(r.atMs)}`;
    out.push(
      ` ${padEnd(r.label + at, 42)}${padStart(showValue(r.measured), 9)}   ${padEnd(`${r.op} ${showValue(r.value)}`, 9)} ${
        r.passed ? VERDICT_PASS : VERDICT_FAIL
      }`,
    );
  }
  return out;
}

/** Dòng liệt kê cuối báo cáo: người đọc không nên phải cuộn ngược lên tìm mục nào hỏng. */
function failureLines(failed) {
  return failed.map((r) => {
    const why = r.measured === null ? (r.reason ?? "không đo được") : `đo ${showValue(r.measured)}, cần ${r.op} ${showValue(r.value)}`;
    const extra = r.measured !== null && r.reason ? ` — ${r.reason}` : "";
    return ` Không đạt: ${r.label} (${why})${extra}`;
  });
}

function toJsonPayload(data) {
  const s = data.stats ?? {};
  return {
    kind: data.kind,
    name: data.name ?? null,
    baseUrl: data.baseUrl ?? null,
    elapsedMs: data.elapsedMs ?? null,
    verdict: data.skipped ? VERDICT_SKIP : data.expectations ? (data.expectations.passed ? VERDICT_PASS : VERDICT_FAIL) : null,
    skipped: data.skipped ?? null,
    saved: s.saved ?? 0,
    idempotent: s.idempotent ?? 0,
    duplicate: s.duplicate ?? 0,
    invalid: s.invalid ?? 0,
    invalidLocation: s.invalidLocation ?? 0,
    busy429: s.busy429 ?? 0,
    blocked: s.blocked ?? 0,
    netError: s.netError ?? 0,
    otherError: s.otherError ?? 0,
    saveFailed: s.saveFailed ?? 0,
    recognizeOk: s.recognizeOk ?? 0,
    recognizeFailed: s.recognizeFailed ?? 0,
    recognizeAccepted202: s.recognizeAccepted202 ?? 0,
    recognizePolls: s.recognizePolls ?? 0,
    heartbeats: s.heartbeats ?? 0,
    saveMs: s.saveMs ?? { p50: null, p95: null, min: null, max: null, n: 0 },
    recognizeMs: s.recognizeMs ?? { p50: null, p95: null, min: null, max: null, n: 0 },
    byStatus: data.byStatus ?? {},
    duplicateRequestIds: s.duplicateRequestIds ?? [],
    expectations: (data.expectations?.results ?? []).map((r) => ({
      check: r.check,
      label: r.label,
      measured: r.measured,
      op: r.op,
      value: r.value,
      passed: r.passed,
      reason: r.reason ?? null,
    })),
    notes: s.notes ?? [],
    problems: s.problems ?? [],
  };
}

/**
 * @param {object} data  xem toJsonPayload để biết đủ khoá
 * @param {{json?: boolean}} opts
 * @returns {string} báo cáo (JSON một dòng khi opts.json)
 */
export function renderReport(data, { json = false } = {}) {
  if (json) return JSON.stringify(toJsonPayload(data));

  const lines = [];
  const s = data.stats ?? {};

  lines.push(WIDE);
  if (data.kind === "scenario") {
    lines.push(` KỊCH BẢN  ${data.name}`);
    if (data.description) lines.push(` ${data.description}`);
    lines.push(` Máy chủ   ${data.baseUrl}      Bắt đầu ${clock(data.startedAt ?? Date.now())}`);
  } else {
    lines.push(` THIẾT BỊ ẢO · ${data.devices} thiết bị · ${data.duration} s · seed ${data.seed}`);
    lines.push(` Máy chủ: ${data.baseUrl}`);
  }
  lines.push(WIDE);

  if (data.skipped) {
    lines.push(` ${VERDICT_SKIP} (${data.skipped})`);
    lines.push(WIDE);
    return lines.join("\n");
  }

  if (data.kind === "scenario") {
    for (const entry of data.log ?? []) lines.push(` [${padStart(secs(entry.tMs), 5)}] ${entry.text}`);
    lines.push(THIN);
    lines.push(...expectationRows(data.expectations?.results ?? []));
    lines.push(THIN);
  } else {
    lines.push(` Phiếu gửi thành công    ${padStart(s.saved ?? 0, 6)}`);
    lines.push(`   trong đó idempotent   ${padStart(s.idempotent ?? 0, 6)}`);
    lines.push(` Trùng nhãn (409)        ${padStart(s.duplicate ?? 0, 6)}`);
    lines.push(` Dữ liệu sai (422)       ${padStart(s.invalid ?? 0, 6)}`);
    lines.push(` Vị trí lạ (422)         ${padStart(s.invalidLocation ?? 0, 6)}`);
    lines.push(` Quá tải nhận dạng (429) ${padStart(s.busy429 ?? 0, 6)}`);
    lines.push(` Bị chặn (503)           ${padStart(s.blocked ?? 0, 6)}`);
    lines.push(` Lỗi mạng                ${padStart(s.netError ?? 0, 6)}`);
    lines.push(` Nhận dạng hỏng          ${padStart(s.recognizeFailed ?? 0, 6)}`);
    lines.push(` ${padEnd("Nhận 202 (bất đồng bộ)", 24)}${padStart(s.recognizeAccepted202 ?? 0, 6)}`);
    lines.push(` ${padEnd("  lượt thăm dò", 24)}${padStart(s.recognizePolls ?? 0, 6)}`);
    lines.push(` Lỗi khác                ${padStart(s.otherError ?? 0, 6)}`);
    lines.push(THIN);
  }

  lines.push(msLine("Thời gian LƯU (ms)", s.saveMs));
  lines.push(msLine("Thời gian NHẬN DẠNG (ms)", s.recognizeMs));
  lines.push(...statusLines(data.byStatus));
  lines.push(` requestId trùng: ${(s.duplicateRequestIds ?? []).length}`);

  for (const note of s.notes ?? []) lines.push(` · ${note}`);
  for (const problem of s.problems ?? []) lines.push(` ! ${problem}`);

  lines.push(THIN);
  if (data.kind === "scenario") {
    const e = data.expectations ?? { passed: false, failed: [], total: 0, passedCount: 0 };
    lines.push(
      ` KẾT QUẢ:  ${e.passed ? VERDICT_PASS : VERDICT_FAIL}  (${e.passedCount}/${e.total} kỳ vọng)          Tổng thời gian ${secs(
        data.elapsedMs ?? 0,
      )}`,
    );
    if (!e.passed) lines.push(...failureLines(e.failed));
  } else {
    lines.push(` Tổng thời gian ${secs(data.elapsedMs ?? 0)}`);
  }
  lines.push(WIDE);
  return lines.join("\n");
}

export { toJsonPayload };
