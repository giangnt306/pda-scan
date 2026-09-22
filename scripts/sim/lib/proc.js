/* Khởi động và DỪNG tiến trình con một cách an toàn.
 *
 * Bối cảnh: track này khởi động nhiều tiến trình, và đã có sự cố giết nhầm tiến trình của
 * người khác. Nên luật ở đây là luật, không phải lời khuyên:
 *
 *   1. Chỉ dừng tiến trình do CHÍNH module này khởi động. Không có hàm nào nhận PID từ bên
 *      ngoài. Không đọc PID từ file dùng chung, từ `ss`, từ bảng tiến trình, từ bất kỳ bộ dò cổng nào.
 *   2. Tín hiệu chỉ gửi qua handle của tiến trình con (child.kill), không bao giờ gửi theo PID
 *      trần — PID có thể đã bị hệ điều hành cấp lại cho tiến trình khác.
 *   3. Trước khi gửi tín hiệu, ĐỐI CHIẾU dòng lệnh đang chạy ở /proc/<pid>/cmdline với dòng
 *      lệnh đã ghi lúc spawn. Lệch nhau → TỪ CHỐI gửi và báo lý do.
 *   4. Không có "giết hàng loạt". Không có mẫu tên. Một handle, một tiến trình.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

export const DEFAULT_GRACE_MS = 8000;

/** Dòng lệnh thật của một PID theo /proc. Trả null khi tiến trình không còn hoặc không đọc được. */
export function cmdlineOf(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const parts = raw.split("\0").filter((s) => s !== "");
    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

const sameCmdline = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Khởi động một tiến trình con và ghi lại dòng lệnh THẬT của nó ngay sau khi spawn.
 * @returns handle { pid, child, expectedCmdline, exited, exitInfo }
 */
export function spawnGuarded({ command, args = [], env = {}, cwd = process.cwd(), onLine = null }) {
  if (typeof command !== "string" || command === "") throw new Error("spawnGuarded cần command");
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });

  const handle = {
    pid: child.pid,
    child,
    /* Đọc ngay lúc này: nếu tiến trình chết quá nhanh thì /proc đã biến mất và ta ghi lại
     * dòng lệnh dự kiến — stopGuarded sẽ thấy tiến trình không còn và không gửi gì cả. */
    expectedCmdline: cmdlineOf(child.pid) ?? [command, ...args],
    exited: false,
    exitInfo: null,
    output: [],
  };

  const onChunk = (chunk) => {
    const text = String(chunk);
    handle.output.push(text);
    if (handle.output.length > 400) handle.output.shift();
    if (onLine) for (const line of text.split("\n")) if (line.trim() !== "") onLine(line);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("exit", (code, signal) => {
    handle.exited = true;
    handle.exitInfo = { code, signal };
  });
  child.on("error", (err) => {
    handle.exited = true;
    handle.exitInfo = { code: null, signal: null, error: err?.message ?? String(err) };
  });

  return handle;
}

/**
 * Tiến trình đang chạy có ĐÚNG là tiến trình ta đã khởi động không?
 * @returns { owned: boolean, reason: string }
 */
export function verifyOwned(handle) {
  if (!handle || typeof handle.pid !== "number") return { owned: false, reason: "handle không hợp lệ" };
  if (handle.exited) return { owned: false, reason: "tiến trình đã thoát" };
  const live = cmdlineOf(handle.pid);
  if (live === null) return { owned: false, reason: `PID ${handle.pid} không còn trong /proc` };
  if (!sameCmdline(live, handle.expectedCmdline)) {
    return {
      owned: false,
      reason: `PID ${handle.pid} nay là tiến trình KHÁC (đang chạy: ${live.join(" ")}) — từ chối gửi tín hiệu`,
    };
  }
  return { owned: true, reason: "" };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Dừng tiến trình đã khởi động: SIGINT, chờ graceMs, đối chiếu lại rồi mới SIGKILL.
 * KHÔNG BAO GIỜ gửi tín hiệu khi đối chiếu dòng lệnh thất bại.
 * @returns { stopped, signalled, refused, reason }
 */
export async function stopGuarded(handle, { graceMs = DEFAULT_GRACE_MS } = {}) {
  if (!handle) return { stopped: true, signalled: false, refused: false, reason: "không có handle" };
  if (handle.exited) return { stopped: true, signalled: false, refused: false, reason: "tiến trình đã tự thoát" };

  const check = verifyOwned(handle);
  if (!check.owned) {
    return { stopped: handle.exited, signalled: false, refused: true, reason: check.reason };
  }

  handle.child.kill("SIGINT");
  const deadline = Date.now() + graceMs;
  while (!handle.exited && Date.now() < deadline) await wait(50);
  if (handle.exited) return { stopped: true, signalled: true, refused: false, reason: "thoát sau SIGINT" };

  /* Còn sống sau graceMs: đối chiếu LẠI trước khi dùng SIGKILL. Giữa hai lần kiểm, tiến trình
   * có thể đã thoát và PID bị cấp lại cho người khác. */
  const recheck = verifyOwned(handle);
  if (!recheck.owned) return { stopped: handle.exited, signalled: true, refused: true, reason: recheck.reason };
  handle.child.kill("SIGKILL");
  const hardDeadline = Date.now() + 3000;
  while (!handle.exited && Date.now() < hardDeadline) await wait(50);
  return { stopped: handle.exited, signalled: true, refused: false, reason: "thoát sau SIGKILL" };
}
