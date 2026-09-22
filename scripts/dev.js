#!/usr/bin/env node
/* Chạy đồng thời AI server, Main Backend (loopback) và Vite dev server (LAN, HTTPS).
 * Ctrl+C dừng sạch tất cả: chuyển tiếp SIGINT/SIGTERM cho cả PROCESS GROUP của từng tiến trình con
 * (npm + node/vite cháu), chờ chúng thoát; nếu một bên chết bất thường thì dừng những bên còn lại.
 * Vì spawn detached, SIGINT từ TTY không tự đến tiến trình con nữa — dev.js là nơi duy nhất
 * chuyển tiếp tín hiệu, nên không còn cảnh "vừa nhận từ TTY vừa nhận từ cha".
 * Không dùng dependency ngoài (concurrently…) để giữ root gọn. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const COLORS = { server: "\x1b[36m", webapp: "\x1b[35m", ai: "\x1b[33m" };
const RESET = "\x1b[0m";

function prefixed(name, stream, out) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.write(`${COLORS[name]}[${name}]${RESET} ${buf.slice(0, i)}\n`);
      buf = buf.slice(i + 1);
    }
  });
  stream.on("end", () => buf && out.write(`${COLORS[name]}[${name}]${RESET} ${buf}\n`));
}

function start(name, args) {
  // detached: true → mỗi tiến trình con là một process group riêng (pgid = pid của nó).
  // Nhờ vậy killTree() giết được cả `npm` lẫn tiến trình `node`/`vite` cháu bên dưới; trước đây
  // child.kill() chỉ giết `npm`, để lại 3 server orphan giữ cổng 3000/8000/5173.
  const child = spawn(npm, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: false,
    detached: process.platform !== "win32",
  });
  prefixed(name, child.stdout, process.stdout);
  prefixed(name, child.stderr, process.stderr);
  // KHÔNG child.unref(): dev.js phải sống tới khi con chết hẳn.
  return child;
}

/* Cố tình KHÔNG bỏ qua tiến trình đã exitCode !== null: `npm` có thể chết trước mà `node`/`vite`
 * cháu vẫn sống và vẫn giữ cổng. Linux không tái sử dụng một PID đang là PGID, nên gửi tín hiệu
 * cho -pid sau khi npm chết vẫn trúng đúng nhóm đó, hoặc ESRCH (đã sạch) và được bỏ qua. */
function killTree(child, signal) {
  if (!child || child.pid === undefined) return;
  try {
    // Dấu trừ = gửi tín hiệu cho cả process group. Windows không có khái niệm này.
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (err) {
    if (err.code !== "ESRCH") throw err; // ESRCH = group đã chết rồi, bỏ qua
  }
}

function lanAddresses() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) out.push(`${a.address} (${ifname})`);
    }
  }
  return out;
}

/* Kiểm cổng TRƯỚC khi spawn. `node --watch` không thoát khi server crash vì EADDRINUSE mà treo ở
 * "Waiting for file changes", nên dev.js không thấy con chết và webapp cứ proxy vào cổng chết → 500.
 * Kết nối được tới 127.0.0.1:<cổng> = đã có ai nghe (cả bind 0.0.0.0 lẫn loopback).
 * ponytail: cổng cố định theo mặc định; đổi PORT trong .env thì sửa cả ở đây. */
const withAi = !["1", "true"].includes(String(process.env.WITHOUT_AI || "").toLowerCase());
const PORTS = { ...(withAi && { ai: 8000 }), server: 3000, webapp: 5173 };
const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
const busy = [];
for (const [name, port] of Object.entries(PORTS)) if (await portBusy(port)) busy.push(`${name} :${port}`);
if (busy.length) {
  console.error(`[dev] Cổng đang bị chiếm: ${busy.join(", ")} — thường là lần \`npm run dev\` trước chưa tắt hẳn.`);
  console.error("[dev] Xem tiến trình giữ cổng:  ss -ltnp | grep -E ':(3000|8000|5173) '");
  console.error("[dev] Rồi dừng cả nhóm của nó:  kill -TERM -<PGID>   (PGID: ps -o pgid= -p <PID>)");
  process.exit(1);
}

const children = new Map();
// AI server (LLM OCR) chạy kèm trừ khi WITHOUT_AI=1. Chưa có OPENAI_API_KEY thì nó vẫn lên
// và trả 503; BE chỉ gọi tới khi apps/server/.env đặt RECOGNITION_PROVIDER=http.
if (withAi) {
  children.set("ai", start("ai", ["run", "dev", "--workspace", "@pda-scan/ai-server"]));
}
children.set("server", start("server", ["run", "dev", "--workspace", "@pda-scan/server"]));
children.set("webapp", start("webapp", ["run", "dev", "--workspace", "@pda-scan/webapp"]));

if (["1", "true"].includes(String(process.env.DEV_VERBOSE || "").toLowerCase())) {
  console.log(`[dev] ${[...children].map(([name, c]) => `${name} pid=${c.pid}`).join(" · ")}`);
}

console.log(`Đang khởi động ${children.has("ai") ? "AI server (loopback :8000) + " : ""}BE (loopback :3000) + webapp (LAN :5173). Địa chỉ LAN có thể dùng trên PDA:`);
for (const a of lanAddresses()) console.log(`  https://${a.split(" ")[0]}:5173   ${a}`);
console.log("Ctrl+C để dừng cả hai.\n");

let shuttingDown = false;
// Khai báo trước shutdown() để không có rủi ro TDZ khi tín hiệu tới sớm; gán ở cuối file.
let parentWatch = null;
function shutdown(signal = "SIGTERM", code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentWatch) clearInterval(parentWatch); // đang tắt rồi thì canh gác không còn việc gì
  for (const child of children.values()) killTree(child, signal);
  // 3000 ms (trước là 4000): nghiệm thu đòi 0 cổng còn mở sau 5 giây kể từ Ctrl+C.
  const force = setTimeout(() => {
    for (const child of children.values()) killTree(child, "SIGKILL");
  }, 3000).unref();
  const waitAll = [...children.values()].map(
    (c) => new Promise((r) => (c.exitCode !== null ? r() : c.once("exit", r))),
  );
  Promise.all(waitAll).then(() => {
    clearTimeout(force);
    console.log(`[dev] đã dừng ${children.size} tiến trình`);
    process.exit(code);
  });
}

for (const [name, child] of children) {
  child.on("exit", (code, sig) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} đã thoát (${sig || code}); dừng tiến trình còn lại.`);
    shutdown("SIGTERM", code || 1);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* CANH GÁC TỔ TIÊN — đường dừng thứ hai, độc lập với tín hiệu.
 *
 * Lý do: `npm run dev & kill -INT $!` chỉ báo cho tiến trình `npm` trung gian, KHÔNG phải cho
 * dev.js, nên ba server con sẽ giữ cổng 3000/8000/5173 mãi mãi. Tín hiệu chỉ tới đúng chỗ khi
 * gửi cho cả process group (`kill -INT -$!`, đúng như Ctrl+C thật) hoặc gọi thẳng `node scripts/dev.js`.
 *
 * Vì sao không chỉ nhìn process.ppid: chuỗi thật là `npm` → `sh -c node scripts/dev.js` → dev.js.
 * Giết `npm` thì `sh` vẫn sống và vẫn là cha của dev.js, nên ppid của dev.js KHÔNG đổi (đã đo).
 * Dấu hiệu đúng nằm cao hơn một bậc: `sh` bị nhận nuôi, tức ppid của CHÍNH NÓ đổi. Nên ta chụp
 * lại cả chuỗi tổ tiên lúc khởi động rồi soi lại mỗi 1000 ms; bất kỳ mắt xích nào biến mất hoặc
 * đổi cha nghĩa là người khởi chạy đã chết → tự dừng sạch.
 *
 * So sánh với chuỗi CHỤP LÚC ĐẦU (chứ không phải "ppid === 1") để không báo động nhầm khi người
 * dùng cố ý chạy nền (`nohup`, `setsid`, `disown`) — lúc đó ppid vốn đã là 1 từ đầu và giữ nguyên.
 * Ngoài Linux không có /proc: parentOf() trả 0 cho mọi mắt xích, chuỗi chụp lúc đầu cũng toàn 0,
 * nên canh gác lặng lẽ thu về đúng phép kiểm ppid cơ bản, không bao giờ báo động nhầm.
 * .unref(): canh gác không được giữ event loop sống dai khi đang tắt. */
function parentOf(pid) {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid …" — comm có thể chứa khoảng trắng và dấu ngoặc,
    // nên cắt từ dấu ')' CUỐI CÙNG rồi mới tách theo khoảng trắng.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0;
  } catch {
    return 0; // không đọc được = tiến trình đã chết (hoặc hệ điều hành không có /proc)
  }
}
function ancestorChain() {
  const chain = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const parent = parentOf(pid);
    chain.push({ pid, parent });
    if (parent <= 1) break;
    pid = parent;
  }
  return chain;
}
const initialPpid = process.ppid;
const initialChain = ancestorChain();
parentWatch = setInterval(() => {
  if (shuttingDown) return;
  let reason = null;
  if (process.ppid !== initialPpid) reason = `ppid đổi ${initialPpid} → ${process.ppid}`;
  else {
    const broken = initialChain.find((link) => parentOf(link.pid) !== link.parent);
    if (broken) reason = `tổ tiên pid=${broken.pid} đã chết hoặc bị nhận nuôi (cha ${broken.parent} → ${parentOf(broken.pid)})`;
  }
  if (!reason) return;
  console.error(`[dev] người khởi chạy đã biến mất (${reason}); dừng các tiến trình con để không giữ cổng.`);
  shutdown("SIGTERM", 0);
}, 1000);
parentWatch.unref();
