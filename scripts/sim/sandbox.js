#!/usr/bin/env node
/* Hộp cát — dựng MỘT máy chủ riêng, chạy kịch bản trên đó, rồi dọn sạch.
 *
 * Vì sao có file này: chạy kịch bản vào máy chủ dev của người khác là cách chắc chắn nhất để
 * vừa làm hỏng việc của họ vừa nhận về số đo vô nghĩa. Hộp cát cho mỗi lần chạy một cổng
 * riêng trong dải 39000–39999 và một DATA_DIR tạm riêng, nằm ngoài kho mã.
 *
 * LUẬT AN TOÀN (đây là yêu cầu chức năng, không phải lời khuyên):
 *   · Tiến trình máy chủ do CHÍNH file này khởi động, qua lib/proc.js.
 *   · Lúc dọn dẹp chỉ dừng đúng tiến trình đó, sau khi ĐỐI CHIẾU dòng lệnh đang chạy ở
 *     /proc/<pid>/cmdline với dòng lệnh đã ghi lúc spawn. Lệch → từ chối gửi tín hiệu.
 *   · Không có mẫu tên tiến trình, không có danh sách tiến trình, không có giết hàng loạt.
 *   · Dọn dẹp nằm trong finally: kịch bản hỏng giữa chừng vẫn không để lại tiến trình treo.
 *
 * Đường dẫn tới mã nguồn máy chủ KHÔNG được viết cứng trong file này — truyền bằng
 * --server-entry để hộp cát không phụ thuộc vào bố cục kho mã của đội khác.
 *
 * MỘT MÁY CHỦ CHO MỖI CẤU HÌNH: một kịch bản có thể đòi máy chủ chạy ở cấu hình khác
 * (`serverEnv` trong file kịch bản, ví dụ RECOGNITION_MODE=async). Hộp cát gom các kịch bản
 * theo cấu hình: khi cấu hình đổi, nó DỪNG máy chủ cũ (đối chiếu cmdline như mọi khi), xoá
 * DATA_DIR của nó, rồi dựng máy chủ mới trên cổng mới. Không bao giờ có hai máy chủ cùng sống.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnGuarded, stopGuarded } from "./lib/proc.js";
import { createAdminClient } from "./lib/client.js";
import { loadScenario, runScenario, listScenarios, ScenarioError, EXIT_PASS, EXIT_FAIL } from "./run-scenario.js";

const PORT_MIN = 39000;
const PORT_MAX = 39999;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePortInRange() {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      if (left <= 0) return reject(new Error(`Không tìm được cổng trống trong ${PORT_MIN}–${PORT_MAX}`));
      const port = PORT_MIN + (crypto.randomInt(0, PORT_MAX - PORT_MIN + 1) | 0);
      const probe = net.createServer();
      probe.once("error", () => probe.close(() => attempt(left - 1)));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(port)));
    };
    attempt(40);
  });
}

function parseSandboxArgs(argv) {
  const values = {
    serverEntry: null,
    scenario: null,
    env: {},
    recognitionMode: null,
    keepData: false,
    port: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const take = () => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Tham số ${name} thiếu giá trị`);
      i += 1;
      return next;
    };
    switch (name) {
      case "--server-entry":
        values.serverEntry = take();
        break;
      case "--scenario":
        values.scenario = take();
        break;
      case "--port":
        values.port = Number(take());
        break;
      case "--env":
        for (const pair of take().split(",")) {
          const at = pair.indexOf("=");
          if (at > 0) values.env[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
        }
        break;
      case "--recognition-mode": {
        const mode = take();
        if (mode !== "sync" && mode !== "async") throw new Error(`--recognition-mode phải là sync hoặc async, nhận "${mode}"`);
        values.recognitionMode = mode;
        break;
      }
      case "--keep-data":
        values.keepData = true;
        break;
      case "--json":
        values.json = true;
        break;
      case "--help":
        values.help = true;
        break;
      default:
        throw new Error(`Tham số không hiểu: ${name}`);
    }
  }
  return values;
}

const HELP = `Hộp cát — dựng máy chủ riêng rồi chạy kịch bản trên đó.

  node scripts/sim/sandbox.js --server-entry <đường/dẫn/index.js> [tham số…]

  --server-entry <path>  BẮT BUỘC — điểm khởi động của Main Backend
  --scenario <a,b,c>     danh sách kịch bản, ngăn bằng dấu phẩy (mặc định: tất cả)
  --port <n>             cổng cố định trong 39000–39999 (mặc định: chọn ngẫu nhiên cổng trống)
  --env "K=V,K2=V2"      biến môi trường thêm cho máy chủ
  --recognition-mode <m> sync | async — đặt RECOGNITION_MODE cho máy chủ
  --keep-data            giữ lại DATA_DIR tạm để soi SQLite sau khi chạy
  --json                 mỗi kịch bản in một dòng JSON
  --help                 in trợ giúp này

Máy chủ luôn chạy với HOST=127.0.0.1, SIM_OVERRIDE=true, RECOGNITION_PROVIDER=mock và một
DATA_DIR tạm riêng — không bao giờ đụng dữ liệu thật.

Kịch bản có thể khai "serverEnv" trong file JSON của nó (ví dụ RECOGNITION_MODE=async). Cấu
hình đó THẮNG --env và --recognition-mode, vì nó là điều kiện để kịch bản còn đo được gì đó.
Khi cấu hình đổi, hộp cát dựng lại máy chủ trên cổng mới trước khi chạy kịch bản kế tiếp.`;

/**
 * Biến môi trường THÊM cho máy chủ của một kịch bản, theo thứ tự ưu tiên tăng dần:
 * --env / --recognition-mode (người gõ lệnh) → serverEnv của kịch bản.
 *
 * Kịch bản thắng có chủ ý: `serverEnv` là điều kiện để kịch bản còn đo được thứ nó nói nó đo.
 * Chạy async-recognition-no-stuck-jobs trên máy chủ `sync` thì mọi kỳ vọng của nó đều vô nghĩa.
 */
export function serverEnvFor(values, scenario) {
  const out = { ...(values?.env ?? {}) };
  if (values?.recognitionMode) out.RECOGNITION_MODE = values.recognitionMode;
  for (const [key, value] of Object.entries(scenario?.serverEnv ?? {})) out[key] = value;
  return out;
}

/** Chữ ký so sánh được của một bộ biến môi trường — dùng để biết có phải dựng lại máy chủ không. */
export function envSignature(env) {
  return JSON.stringify(Object.entries(env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function waitHealthy(baseUrl, { timeoutMs = 30_000 } = {}) {
  const admin = createAdminClient(baseUrl, { timeoutMs: 3000 });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await admin.get("/api/health");
    if (res.ok) return true;
    await sleep(250);
  }
  return false;
}

async function main(argv) {
  let values;
  try {
    values = parseSandboxArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.serverEntry) {
    console.error("Thiếu --server-entry <đường/dẫn/index.js>. Xem --help.");
    return 2;
  }
  const entry = path.resolve(values.serverEntry);
  if (!fs.existsSync(entry)) {
    console.error(`Không thấy điểm khởi động máy chủ: ${entry}`);
    return 2;
  }
  if (values.port !== null && (!Number.isInteger(values.port) || values.port < PORT_MIN || values.port > PORT_MAX)) {
    console.error(`--port phải trong khoảng ${PORT_MIN}..${PORT_MAX}`);
    return 2;
  }

  const names = values.scenario ? values.scenario.split(",").map((s) => s.trim()).filter(Boolean) : listScenarios();
  if (names.length === 0) {
    console.error("Không có kịch bản nào để chạy");
    return 2;
  }

  /* Máy chủ ĐANG sống, nếu có. PID chỉ tồn tại ở đây — không ghi ra file, không đọc từ đâu. */
  let server = null;
  let failures = 0;
  let startupError = null;

  /** Dừng máy chủ hiện tại (nếu có) và xoá DATA_DIR của nó. Gọi được nhiều lần. */
  async function stopServer() {
    if (!server) return;
    const dying = server;
    server = null;
    const result = await stopGuarded(dying.handle);
    if (result.refused) console.error(`! Từ chối dừng tiến trình: ${result.reason}`);
    else console.log(`Hộp cát: đã dừng máy chủ PID ${dying.handle.pid} (${result.reason})`);
    if (!values.keepData) fs.rmSync(dying.dataDir, { recursive: true, force: true });
    else console.log(`Giữ lại DATA_DIR: ${dying.dataDir}`);
  }

  /** Máy chủ đang chạy đúng cấu hình `extraEnv`; dựng lại nếu cấu hình khác. */
  async function ensureServer(extraEnv) {
    const signature = envSignature(extraEnv);
    if (server && server.signature === signature) return server;
    await stopServer();

    const port = values.port ?? (await freePortInRange());
    /* mktemp: thư mục riêng cho MỖI máy chủ. KHÔNG dùng đường dẫn cố định dùng chung —
     * hai lần chạy song song sẽ ghi đè SQLite của nhau. */
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-sim-"));
    const handle = spawnGuarded({
      command: process.execPath,
      args: [entry],
      env: {
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: dataDir,
        SIM_OVERRIDE: "true",
        RECOGNITION_PROVIDER: "mock",
        LOG_LEVEL: "warn",
        ...extraEnv,
      },
    });
    server = { handle, dataDir, port, signature, baseUrl: `http://127.0.0.1:${port}` };
    const shown = Object.entries(extraEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`Hộp cát: cổng ${port} · DATA_DIR ${dataDir} · PID ${handle.pid}${shown ? ` · ${shown}` : ""}`);

    if (!(await waitHealthy(server.baseUrl))) {
      throw new Error(`Máy chủ không lên sau 30 s. Nhật ký cuối:\n${handle.output.slice(-10).join("")}`);
    }
    return server;
  }

  try {
    for (const name of names) {
      let scenario;
      try {
        scenario = loadScenario(name);
      } catch (err) {
        console.error(`[${name}] ${err.message}`);
        failures += 1;
        continue;
      }

      let target;
      try {
        target = await ensureServer(serverEnvFor(values, scenario));
      } catch (err) {
        /* Không dựng được máy chủ là lỗi hạ tầng, không phải "kịch bản không đạt": dừng hẳn
         * thay vì chạy tiếp các kịch bản còn lại vào hư vô. */
        startupError = err;
        break;
      }

      try {
        const { code, text } = await runScenario(scenario, {
          base: target.baseUrl,
          json: values.json,
          onLog: values.json ? null : (line) => console.log(` · ${line}`),
        });
        console.log(text);
        console.log(`[${name}] mã thoát = ${code}`);
        if (code !== EXIT_PASS) failures += 1;
      } catch (err) {
        console.error(`[${name}] ${err instanceof ScenarioError ? err.message : (err?.stack ?? err)}`);
        failures += 1;
      }
    }
  } finally {
    /* DỌN SẠCH — luôn chạy, kể cả khi một kịch bản ném giữa chừng. Chỉ dừng đúng tiến trình ta
     * đã spawn, sau khi đối chiếu cmdline. */
    await stopServer();
  }

  if (startupError) {
    console.error(startupError.message);
    return 2;
  }
  return failures > 0 ? EXIT_FAIL : EXIT_PASS;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export { main, parseSandboxArgs, freePortInRange };
