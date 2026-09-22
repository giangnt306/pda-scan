/* Thống kê thời gian đo phía client: p50/p95/min/max/n.
 *
 * Không làm tròn, không cắt bớt: các số này đi thẳng vào kỳ vọng của kịch bản
 * (save.p95Ms <= 2000), nên một phép làm tròn ở đây là một lần đổi kết quả chấm điểm.
 */

/** Phân vị theo hạng gần nhất (nearest-rank): p50 của [1..100] = 50, p95 = 95. */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!(p > 0 && p <= 100)) throw new Error(`percentile: p phải trong (0,100], nhận ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** { p50, p95, min, max, n }. Mảng rỗng → mọi phân vị null, n=0. KHÔNG sửa mảng đầu vào. */
export function summarize(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { p50: null, p95: null, min: null, max: null, n: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    n: sorted.length,
  };
}
