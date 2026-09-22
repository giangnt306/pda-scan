import test from "node:test";
import assert from "node:assert/strict";
import { spawnGuarded, stopGuarded, verifyOwned, cmdlineOf } from "../lib/proc.js";

/* Luật an toàn của track này: chỉ dừng tiến trình do chính mình khởi động, và chỉ sau khi
 * đối chiếu dòng lệnh đang chạy với dòng lệnh đã ghi lúc spawn. Hai test dưới kiểm đúng hai
 * nửa của luật đó — nửa "dừng được" và nửa quan trọng hơn: "từ chối khi không chắc". */

const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

test("spawnGuarded ghi lại dòng lệnh thật của tiến trình con, và stopGuarded dừng được đúng tiến trình đó", async () => {
  const handle = spawnGuarded({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  assert.ok(await waitFor(() => cmdlineOf(handle.pid) !== null), "tiến trình con phải xuất hiện trong /proc");
  assert.ok(handle.expectedCmdline.includes(process.execPath));
  assert.equal(verifyOwned(handle).owned, true);

  const result = await stopGuarded(handle, { graceMs: 3000 });
  assert.equal(result.stopped, true);
  assert.equal(result.refused, false);
  assert.equal(handle.exited, true);
  assert.equal(cmdlineOf(handle.pid), null);
});

test("stopGuarded TỪ CHỐI gửi tín hiệu khi dòng lệnh đang chạy khác dòng lệnh đã ghi lúc spawn", async () => {
  const handle = spawnGuarded({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  assert.ok(await waitFor(() => cmdlineOf(handle.pid) !== null));

  /* Giả lập đúng tai nạn ta sợ nhất: PID đã bị hệ điều hành cấp lại cho tiến trình khác.
   * Dòng lệnh ghi lúc spawn không còn khớp → PHẢI từ chối, không được gửi tín hiệu. */
  handle.expectedCmdline = ["/usr/bin/some-other-program", "--of-someone-else"];

  const check = verifyOwned(handle);
  assert.equal(check.owned, false);
  assert.match(check.reason, /tiến trình KHÁC/);

  const result = await stopGuarded(handle, { graceMs: 500 });
  assert.equal(result.refused, true);
  assert.equal(result.signalled, false);
  assert.equal(handle.exited, false, "tiến trình vẫn phải còn sống — ta đã từ chối giết nó");

  // Dọn dẹp: khôi phục dòng lệnh thật rồi mới dừng.
  handle.expectedCmdline = cmdlineOf(handle.pid);
  const cleanup = await stopGuarded(handle, { graceMs: 3000 });
  assert.equal(cleanup.stopped, true);
});

test("stopGuarded với handle của tiến trình đã tự thoát không gửi tín hiệu nào", async () => {
  const handle = spawnGuarded({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.ok(await waitFor(() => handle.exited === true), "tiến trình phải tự thoát");

  const result = await stopGuarded(handle);
  assert.equal(result.signalled, false);
  assert.equal(result.refused, false);
  assert.equal(result.stopped, true);
});
