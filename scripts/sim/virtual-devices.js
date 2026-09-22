#!/usr/bin/env node
/* Thiết bị ảo — CLI độc lập.
 *
 * File này KHÔNG đọc file kịch bản JSON: nó chỉ biết tham số dòng lệnh. Bộ chạy kịch bản
 * (run-scenario.js) dùng chung lib/fleet.js nhưng đi đường riêng — trộn hai đường vào một
 * chỗ sẽ làm cả hai khó kiểm.
 *
 * AN TOÀN: không khởi động, không dừng, không gửi tín hiệu cho tiến trình nào.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, DEVICE_HELP, isOutsideSimPortRange } from "./lib/args.js";
import { createAdminClient } from "./lib/client.js";
import { createFleet } from "./lib/fleet.js";
import { renderReport } from "./lib/report.js";

export const EXIT_OK = 0;
export const EXIT_HAS_ERRORS = 1;
export const EXIT_CONFIG = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function readByStatus(admin) {
  const res = await admin.get("/api/receipts?limit=1", { timeoutMs: 10_000 });
  return res.body?.counts?.byStatus ?? {};
}

export async function runDevices(options, { onLog = null } = {}) {
  const startedAt = Date.now();
  const admin = createAdminClient(options.base);
  const fleet = createFleet({ options, log: onLog });
  const control = { stopping: false };

  const onSigint = () => {
    control.stopping = true;
  };
  process.on("SIGINT", onSigint);

  try {
    if (options.uploads > 0) {
      await fleet.burst({ count: options.uploads, concurrency: Math.min(options.uploads, options.devices * 20 || 20) });
    } else {
      await fleet.start();
      if (options.duration > 0) {
        const until = startedAt + options.duration * 1000;
        while (Date.now() < until && !control.stopping) await sleep(Math.min(200, until - Date.now()));
      } else {
        while (!control.stopping) await sleep(200);
      }
    }
  } finally {
    /* Dọn sạch dù chạy hết giờ, bị Ctrl+C hay ném giữa chừng: kết mọi phiên đã mở. */
    await fleet.stop().catch(() => {});
    process.off("SIGINT", onSigint);
  }

  const byStatus = await readByStatus(admin);
  return {
    kind: "devices",
    devices: options.devices,
    duration: options.duration,
    seed: options.seed,
    baseUrl: options.base,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    stats: fleet.stats.summary(),
    byStatus,
    expectations: null,
    interrupted: control.stopping,
  };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return EXIT_CONFIG;
  }
  const options = parsed.values;
  if (options.help) {
    console.log(DEVICE_HELP);
    return EXIT_OK;
  }
  if (isOutsideSimPortRange(options.base)) {
    console.error(`! Cảnh báo: --base ${options.base} nằm ngoài dải cổng 39000–39999 dành cho mô phỏng`);
  }

  const quiet = options.quiet || options.json;
  const data = await runDevices(options, { onLog: quiet ? null : (line) => console.log(` · ${line}`) });
  console.log(renderReport(data, { json: options.json }));

  if (data.interrupted) return 130;
  return data.stats.otherError > 0 ? EXIT_HAS_ERRORS : EXIT_OK;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export { main };
