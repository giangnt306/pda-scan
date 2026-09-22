#!/usr/bin/env node
/* Bộ chạy kịch bản — chạy một kịch bản rồi TỰ CHẤM.
 *
 * Điều quan trọng nhất của file này là MÃ THOÁT: 0 = ĐẠT (hoặc SKIPPED), 1 = KHÔNG ĐẠT,
 * 2 = lỗi tham số / không chạy được, 130 = Ctrl+C. CI và người dùng chỉ cần nhìn mã thoát.
 *
 * AN TOÀN: file này KHÔNG khởi động và KHÔNG dừng một tiến trình nào. Không có action nào
 * `kill`. "Máy chủ ngừng hoạt động" được diễn bằng sim.set {"backend":{"mode":"down"}}, không
 * bằng cách giết tiến trình. Việc kill thật là thao tác tay, có trong playbook.
 *
 * Sáu pha, thứ tự cố định: TIỀN KIỂM → ẢNH CHỤP ĐẦU → CHẠY BƯỚC → LẮNG → ẢNH CHỤP CUỐI → CHẤM.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenarioArgs, SCENARIO_HELP, MISSING_BASE_SCENARIO, isOutsideSimPortRange } from "./lib/args.js";
import { createAdminClient } from "./lib/client.js";
import { createFleet, createStats } from "./lib/fleet.js";
import { runExpectations, evaluate, validateExpectation, ExpectError } from "./lib/expect.js";
import { renderReport } from "./lib/report.js";

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_CONFIG = 2;
export const EXIT_INTERRUPTED = 130;

export const ACTIONS = ["sim.set", "sim.clear", "devices.start", "devices.stop", "uploads.burst", "wait", "note", "expectNow"];
export const REQUIREMENTS = ["sim", "events", "async", "sap"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(HERE, "scenarios");

export class ScenarioError extends Error {}

/* Biến môi trường máy chủ mà một kịch bản có thể ĐÒI HỎI (sandbox.js dựng máy chủ với chúng),
 * kèm chỗ đọc lại giá trị THẬT từ GET /api/status. Chỉ liệt kê biến nào máy chủ có báo ra:
 * một đòi hỏi không kiểm lại được thì chỉ là lời chú thích, không phải rào chắn. */
export const OBSERVABLE_SERVER_ENV = {
  RECOGNITION_MODE: (status) => status?.recognition?.mode,
  RECOGNITION_MAX_CONCURRENT: (status) => status?.recognition?.maxConcurrent,
  RECOGNITION_MAX_WAITING: (status) => status?.recognition?.maxWaiting,
  RECOGNITION_TIMEOUT_MS: (status) => status?.recognition?.timeoutMs,
};

/**
 * Máy chủ đang chạy có đúng cấu hình mà kịch bản đòi không?
 * Trả null khi khớp (hoặc khi kịch bản không đòi gì), ngược lại trả câu giải thích.
 *
 * Vì sao cần: kịch bản async chạy nhầm vào máy chủ `sync` sẽ đi hết 60 giây rồi mới đỏ vì
 * thiếu 202. Bắt ngay ở pha tiền kiểm rẻ hơn và nói đúng nguyên nhân.
 */
export function serverEnvMismatch(scenario, statusBody) {
  const want = scenario?.serverEnv;
  if (!want || typeof want !== "object") return null;
  for (const [key, read] of Object.entries(OBSERVABLE_SERVER_ENV)) {
    if (want[key] === undefined) continue;
    const actual = read(statusBody);
    if (String(actual) !== String(want[key])) {
      return (
        `Kịch bản "${scenario.name}" cần máy chủ chạy ${key}=${want[key]}, nhưng máy chủ đang báo ${key}=${actual}.\n` +
        `Dùng hộp cát để nó tự dựng máy chủ đúng cấu hình:\n` +
        `  node scripts/sim/sandbox.js --server-entry apps/server/src/index.js --scenario ${scenario.name}`
      );
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ---------- Nạp và kiểm kịch bản --------------------------------------------------------- */

export function listScenarios() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function validateScenario(scenario, { expectedName = null } = {}) {
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new ScenarioError("Kịch bản phải là một JSON object");
  }
  for (const field of ["name", "steps", "expect"]) {
    if (scenario[field] === undefined) throw new ScenarioError(`Kịch bản thiếu trường bắt buộc: ${field}`);
  }
  if (expectedName && scenario.name !== expectedName) {
    throw new ScenarioError(`Trường name ("${scenario.name}") không khớp tên file ("${expectedName}")`);
  }
  if (!Array.isArray(scenario.steps)) throw new ScenarioError("steps phải là một mảng");
  if (!Array.isArray(scenario.expect)) throw new ScenarioError("expect phải là một mảng");
  /* Kịch bản không tự kiểm là thứ vô dụng nhất trong cả Phase 5: nó chạy 90 giây rồi báo
   * "đạt" mà không hề đo gì. Chặn ngay từ lúc nạp. */
  if (scenario.expect.length === 0) {
    throw new ScenarioError("Kịch bản không có kỳ vọng nào — nó không kiểm được gì");
  }
  for (const req of scenario.requires ?? []) {
    if (!REQUIREMENTS.includes(req)) throw new ScenarioError(`requires không hiểu: ${req} (hợp lệ: ${REQUIREMENTS.join(", ")})`);
  }
  /* serverEnv gõ sai kiểu (số thay vì chuỗi, mảng thay vì object) mà được bỏ qua im lặng sẽ
   * làm hộp cát dựng máy chủ ở cấu hình MẶC ĐỊNH trong khi kịch bản tưởng mình đang chạy async. */
  if (scenario.serverEnv !== undefined) {
    const env = scenario.serverEnv;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new ScenarioError('serverEnv phải là object dạng { "TÊN_BIẾN": "giá trị" }');
    }
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new ScenarioError(`serverEnv: tên biến môi trường không hợp lệ: ${key}`);
      if (typeof value !== "string") throw new ScenarioError(`serverEnv.${key} phải là chuỗi, nhận ${typeof value}`);
    }
  }

  let previousAt = -1;
  for (const [i, step] of scenario.steps.entries()) {
    if (!step || typeof step !== "object") throw new ScenarioError(`steps[${i}] phải là object`);
    if (!Number.isInteger(step.at) || step.at < 0) throw new ScenarioError(`steps[${i}].at phải là số nguyên ≥ 0`);
    if (step.at < previousAt) throw new ScenarioError(`steps[${i}].at = ${step.at} nhỏ hơn bước trước (${previousAt})`);
    previousAt = step.at;
    if (!ACTIONS.includes(step.action)) throw new ScenarioError(`action không hiểu: ${step.action}`);
    if (step.action === "wait" && !Number.isInteger(step.ms)) throw new ScenarioError(`steps[${i}] action wait cần ms`);
    if (step.action === "expectNow") validateExpectation(step);
    if (step.action === "sim.set" && (!step.patch || typeof step.patch !== "object")) {
      throw new ScenarioError(`steps[${i}] action sim.set cần patch`);
    }
    if ((step.action === "sim.set" || step.action === "sim.clear") && step.scope !== undefined) {
      if (step.scope !== "global" && !String(step.scope).startsWith("device:")) {
        throw new ScenarioError(`steps[${i}].scope phải là "global" hoặc "device:<id>"`);
      }
    }
    if (step.action === "uploads.burst" && !Number.isInteger(step.count)) {
      throw new ScenarioError(`steps[${i}] action uploads.burst cần count`);
    }
  }
  for (const item of scenario.expect) validateExpectation(item);
  return scenario;
}

export function loadScenario(nameOrPath) {
  const isPath = nameOrPath.includes("/") || nameOrPath.endsWith(".json");
  const file = isPath ? path.resolve(nameOrPath) : path.join(SCENARIO_DIR, `${nameOrPath}.json`);
  if (!fs.existsSync(file)) {
    throw new ScenarioError(`Không tìm thấy kịch bản "${nameOrPath}". Có sẵn: ${listScenarios().join(", ") || "(không có)"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ScenarioError(`Kịch bản ${file} không parse được: ${err.message}`);
  }
  return validateScenario(parsed, { expectedName: isPath ? null : path.basename(file, ".json") });
}

/* ---------- Đọc số liệu từ máy chủ (nguồn duy nhất theo R1) ------------------------------ */

async function readSnapshot(admin) {
  const receipts = await admin.get("/api/receipts?limit=1");
  const status = await admin.get("/api/status");
  if (receipts.status === 0 || status.status === 0) {
    throw new ScenarioError(`Không đọc được số liệu từ máy chủ: ${receipts.networkError ?? status.networkError}`);
  }
  /* Nguồn DUY NHẤT của mọi check recognitions.* (R1): counts ở đây đếm TOÀN BẢNG, không phải
   * trang hiện tại. Endpoint vắng mặt → để null chứ KHÔNG quy về 0: một kịch bản không đọc
   * được số job còn treo phải báo "không đo được" (⇒ đỏ), không được im lặng đạt. */
  const recognitions = await admin.get("/api/admin/recognitions?limit=1");
  return {
    at: Date.now(),
    receiptsTotal: receipts.body?.counts?.total ?? null,
    byStatus: receipts.body?.counts?.byStatus ?? {},
    outboxPending: status.body?.queue?.outboxPending ?? null,
    backendState: status.body?.backend?.state ?? null,
    simUpdatedAt: status.body?.sim?.updatedAt ?? null,
    recognitionCounts: recognitions.ok && recognitions.body?.counts ? recognitions.body.counts : null,
    recognitionMode: status.body?.recognition?.mode ?? null,
  };
}

async function eventsAvailability(admin) {
  const res = await admin.get("/api/admin/events?since=0&limit=1");
  if (res.status === 404 || res.status === 405) return { available: false, lastId: 0 };
  if (!res.ok) return { available: false, lastId: 0 };
  return { available: true, lastId: res.body?.lastId ?? 0 };
}

async function fetchEvents(admin, sinceId) {
  const all = [];
  let since = sinceId;
  for (let page = 0; page < 50; page += 1) {
    const res = await admin.get(`/api/admin/events?since=${since}&limit=200`);
    if (!res.ok) break;
    const items = Array.isArray(res.body?.items) ? res.body.items : [];
    all.push(...items);
    const lastId = res.body?.lastId ?? since;
    if (!res.body?.hasMore || lastId === since) break;
    since = lastId;
  }
  return all;
}

/* ---------- Chạy một kịch bản ------------------------------------------------------------ */

/**
 * @returns {Promise<{ code: number, text: string, data: object }>}
 */
export async function runScenario(scenario, { base = null, json = false, keepSim = false, onLog = null } = {}) {
  /* KHÔNG có cổng dự phòng ở đây nữa (F-16). Không ai đoán hộ người gõ lệnh xem họ định bắn
   * tải vào máy chủ nào. */
  const baseUrl = base ?? scenario.baseUrl ?? null;
  if (baseUrl === null) throw new ScenarioError(MISSING_BASE_SCENARIO);
  const admin = createAdminClient(baseUrl);
  const stats = createStats();
  const startedAt = Date.now();
  const logEntries = [];
  const warnings = [];
  const control = { interrupted: false };

  const log = (text) => {
    logEntries.push({ tMs: Date.now() - runStartedAt(), text });
    if (onLog) onLog(text);
  };
  let phase3StartedAt = null;
  const runStartedAt = () => phase3StartedAt ?? startedAt;

  const finish = (partial) =>
    renderReport(
      {
        kind: "scenario",
        name: scenario.name,
        description: scenario.description ?? "",
        baseUrl,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        log: logEntries,
        stats: stats.summary(),
        ...partial,
      },
      { json },
    );

  /* --- PHA 1: TIỀN KIỂM ------------------------------------------------------------- */
  const health = await admin.get("/api/health", { timeoutMs: 10_000 });
  if (health.status === 0) {
    throw new ScenarioError(`Không kết nối được ${baseUrl}: ${health.networkError}`);
  }
  if (!health.ok) throw new ScenarioError(`GET /api/health trả ${health.status} ${health.code ?? ""}`.trim());

  const status = await admin.get("/api/status", { timeoutMs: 10_000 });
  if (!status.ok) throw new ScenarioError(`GET /api/status trả ${status.status} ${status.code ?? ""}`.trim());

  const mismatch = serverEnvMismatch(scenario, status.body);
  if (mismatch) throw new ScenarioError(mismatch);

  const requires = scenario.requires ?? [];
  const usesSim = scenario.steps.some((s) => s.action === "sim.set" || s.action === "sim.clear");
  const simEnabled = status.body?.sim?.enabled === true;
  if ((requires.includes("sim") || usesSim) && !simEnabled) {
    throw new ScenarioError("Kịch bản cần SIM_OVERRIDE=true");
  }
  /* Chạy kịch bản vào một máy chủ đã có kịch bản bật sẵn sẽ cho kết quả sai mà không ai biết. */
  if (status.body?.sim?.updatedAt) {
    warnings.push(`Máy chủ ĐANG có kịch bản mô phỏng bật sẵn (updatedAt ${status.body.sim.updatedAt}) — số đo có thể sai lệch`);
  }
  if (isOutsideSimPortRange(baseUrl)) {
    warnings.push(`--base ${baseUrl} nằm ngoài dải cổng 39000–39999 dành cho mô phỏng`);
  }
  for (const w of warnings) log(`! ${w}`);

  const events = await eventsAvailability(admin);
  if (requires.includes("events") && !events.available) {
    return { code: EXIT_PASS, text: finish({ skipped: "endpoint chưa có: /api/admin/events", expectations: null }), data: null };
  }
  if (requires.includes("sap") && (status.body?.sap?.mode ?? "not_configured") === "not_configured") {
    return { code: EXIT_PASS, text: finish({ skipped: "SAP_ADAPTER=none", expectations: null }), data: null };
  }
  if (requires.includes("async") && (status.body?.recognition?.mode ?? "sync") !== "async") {
    return { code: EXIT_PASS, text: finish({ skipped: "RECOGNITION_MODE chưa phải async", expectations: null }), data: null };
  }

  /* --- PHA 2: ẢNH CHỤP ĐẦU ---------------------------------------------------------- */
  const start = await readSnapshot(admin);
  if (start.receiptsTotal === null) throw new ScenarioError("GET /api/receipts không trả counts.total — không chấm được");

  const options = {
    base: baseUrl,
    devices: 1,
    rate: 6,
    duration: 0,
    failRate: 0,
    recognize: false,
    recognizeOnly: false,
    uploads: 0,
    sameLabel: false,
    prefix: scenario.prefix ?? "VD",
    seed: Number.isInteger(scenario.seed) ? scenario.seed : 1,
    heartbeat: 15000,
    warehouse: "WH01",
    shift: "sang",
    noSession: false,
    image: null,
  };
  const fleet = createFleet({ options, stats, log: null });

  const peaks = { waiting: 0, inflight: 0 };
  const nowCtx = (end) => ({
    snapshots: { start, end },
    stats: stats.summary(),
    peaks,
    events: [],
    eventsAvailable: events.available,
    recoveryMs: recoveryMs(),
    });
  const timeline = { lastSimClearAt: null };
  const recoveryMs = () => {
    if (timeline.lastSimClearAt === null) return null;
    const firstAfter = stats.savedAtMs.find((t) => t >= timeline.lastSimClearAt);
    return firstAfter === undefined ? null : firstAfter - timeline.lastSimClearAt;
  };

  const immediateResults = [];
  const background = [];
  let sampler = null;
  let sampling = false;

  const onSigint = () => {
    control.interrupted = true;
  };
  process.on("SIGINT", onSigint);

  try {
    /* --- PHA 3: CHẠY BƯỚC --------------------------------------------------------- */
    phase3StartedAt = Date.now();
    const t0 = phase3StartedAt;
    const deadline = t0 + (scenario.timeoutMs ?? 300_000);

    sampler = setInterval(() => {
      if (sampling) return;
      sampling = true;
      admin
        .get("/api/status", { timeoutMs: 5000 })
        .then((res) => {
          const q = res.body?.queue;
          if (q) {
            peaks.waiting = Math.max(peaks.waiting, q.recognitionsWaiting ?? 0);
            peaks.inflight = Math.max(peaks.inflight, q.recognitionsInflight ?? 0);
          }
        })
        .finally(() => {
          sampling = false;
        });
    }, 500);

    for (const step of scenario.steps) {
      while (Date.now() < t0 + step.at && !control.interrupted) await sleep(Math.min(100, t0 + step.at - Date.now()));
      if (control.interrupted) break;
      if (Date.now() > deadline) throw new ScenarioError(`Vượt timeoutMs (${scenario.timeoutMs ?? 300_000} ms) ở bước at=${step.at}`);

      switch (step.action) {
        case "note":
          log(`note   ${step.text ?? ""}`);
          break;
        case "wait":
          log(`wait   ${step.ms} ms`);
          await sleep(step.ms);
          break;
        case "sim.set": {
          const scope = step.scope ?? "global";
          const p = scope === "global" ? "/api/admin/sim" : `/api/admin/sim/devices/${scope.slice(7)}`;
          const res = await admin.put(p, { json: step.patch });
          if (!res.ok) throw new ScenarioError(`sim.set hỏng: ${res.status} ${res.code ?? res.networkError ?? ""}`);
          log(`sim.set ${scope} ${JSON.stringify(step.patch)}`);
          break;
        }
        case "sim.clear": {
          const scope = step.scope ?? "global";
          const p = scope === "global" ? "/api/admin/sim" : `/api/admin/sim/devices/${scope.slice(7)}`;
          const res = await admin.del(p);
          if (!res.ok) throw new ScenarioError(`sim.clear hỏng: ${res.status} ${res.code ?? res.networkError ?? ""}`);
          timeline.lastSimClearAt = Date.now();
          log(`sim.clear ${scope}`);
          break;
        }
        case "devices.start": {
          const overrides = {
            devices: step.devices ?? 1,
            rate: step.rate ?? 6,
            recognize: step.recognize === true,
            recognizeOnly: step.recognizeOnly === true,
            failRate: step.failRate ?? 0,
            sameLabel: step.sameLabel === true,
            noSession: step.noSession === true,
          };
          if (step.prefix) overrides.prefix = step.prefix;
          await fleet.start(overrides);
          log(
            `devices.start ${overrides.devices} thiết bị, rate ${overrides.rate}${overrides.recognize ? ", recognize" : ""}${
              overrides.recognizeOnly ? ", recognize-only" : ""
            }`,
          );
          break;
        }
        case "devices.stop":
          await fleet.stop({ prefix: step.prefix ?? null });
          log(`devices.stop${step.prefix ? ` prefix=${step.prefix}` : ""}`);
          break;
        case "uploads.burst": {
          const count = step.count;
          const concurrency = step.concurrency ?? count;
          log(`uploads.burst ${count} upload, ${concurrency} đồng thời`);
          /* KHÔNG chặn: kịch bản quá tải còn phải chấm đỉnh hàng đợi TRONG LÚC burst chạy. */
          background.push(fleet.burst({ count, concurrency }));
          break;
        }
        case "expectNow": {
          const liveEnd = await readSnapshot(admin);
          const result = evaluate(step, {
            ...nowCtx(liveEnd),
            events: events.available ? await fetchEvents(admin, events.lastId) : [],
          });
          result.atMs = Date.now() - t0;
          result.label = `${result.label} (ngay lúc đó)`;
          immediateResults.push(result);
          log(`expectNow ${result.label}: đo ${result.measured} ${result.op} ${result.value} → ${result.passed ? "ĐẠT" : "KHÔNG ĐẠT"}`);
          break;
        }
        default:
          throw new ScenarioError(`action không hiểu: ${step.action}`);
      }
    }

    await Promise.all(background);
    clearInterval(sampler);
    sampler = null;

    if (control.interrupted) {
      return { code: EXIT_INTERRUPTED, text: finish({ skipped: "bị ngắt bằng Ctrl+C", expectations: null }), data: null };
    }

    /* --- PHA 4: LẮNG -------------------------------------------------------------- */
    const settleMs = scenario.settleMs ?? 5000;
    log(`lắng ${settleMs} ms…`);
    const settleUntil = Date.now() + settleMs;
    while (Date.now() < settleUntil && !control.interrupted) await sleep(Math.min(200, settleUntil - Date.now()));
    if (control.interrupted) {
      return { code: EXIT_INTERRUPTED, text: finish({ skipped: "bị ngắt bằng Ctrl+C", expectations: null }), data: null };
    }

    /* --- PHA 5: ẢNH CHỤP CUỐI ----------------------------------------------------- */
    const end = await readSnapshot(admin);
    const eventList = events.available ? await fetchEvents(admin, events.lastId) : [];

    /* --- PHA 6: CHẤM -------------------------------------------------------------- */
    const ctx = { ...nowCtx(end), events: eventList };
    const expectations = runExpectations(scenario.expect, ctx, immediateResults);
    const text = finish({ expectations, byStatus: end.byStatus, elapsedMs: Date.now() - startedAt });
    return { code: expectations.passed ? EXIT_PASS : EXIT_FAIL, text, data: { ctx, expectations } };
  } finally {
    /* DỌN SẠCH — chạy kể cả khi kịch bản ném giữa chừng hoặc bị Ctrl+C.
     * Ở đây chỉ có hai việc: dừng thiết bị ảo (kết mọi phiên đã mở) và xoá kịch bản mô phỏng.
     * KHÔNG có tiến trình nào để dừng: bộ chạy chưa bao giờ khởi động tiến trình nào. */
    if (sampler) clearInterval(sampler);
    process.off("SIGINT", onSigint);
    /* THỨ TỰ QUAN TRỌNG: xoá kịch bản mô phỏng TRƯỚC, dừng thiết bị SAU.
     * Ngắt giữa lúc backend.mode=down mà dừng thiết bị trước thì POST /api/sessions/:id/end
     * sẽ ăn 503 của chính kịch bản ta đang dọn, và để lại 5 phiên mở vĩnh viễn. */
    if (!keepSim && usesSim) {
      const res = await admin.del("/api/admin/sim");
      if (!res.ok && res.status !== 0) console.error(`! Không xoá được kịch bản mô phỏng: ${res.status} ${res.code ?? ""}`);
    }
    await fleet.stop().catch(() => {});
  }
}

/* ---------- CLI -------------------------------------------------------------------------- */

async function main(argv) {
  const parsed = parseScenarioArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return EXIT_CONFIG;
  }
  const v = parsed.values;
  if (v.help) {
    console.log(SCENARIO_HELP);
    return EXIT_PASS;
  }
  if (v.list) {
    for (const name of listScenarios()) console.log(name);
    return EXIT_PASS;
  }

  let scenario;
  try {
    scenario = loadScenario(v.scenario);
  } catch (err) {
    console.error(err instanceof ScenarioError || err instanceof ExpectError ? err.message : `Lỗi nạp kịch bản: ${err.message}`);
    return EXIT_CONFIG;
  }

  if (v.base === null && !scenario.baseUrl) {
    console.error(MISSING_BASE_SCENARIO);
    return EXIT_CONFIG;
  }

  try {
    const { code, text } = await runScenario(scenario, {
      base: v.base,
      json: v.json,
      keepSim: v.keepSim,
      onLog: v.json ? null : (line) => console.log(` · ${line}`),
    });
    console.log(text);
    return code;
  } catch (err) {
    if (err instanceof ScenarioError) {
      console.error(`Không chạy được kịch bản: ${err.message}`);
      return EXIT_CONFIG;
    }
    if (err instanceof ExpectError) {
      console.error(`Kỳ vọng khai báo sai: ${err.message}`);
      return EXIT_CONFIG;
    }
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
