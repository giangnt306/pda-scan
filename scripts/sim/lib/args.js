/* Phân tích tham số dòng lệnh cho virtual-devices.js và run-scenario.js.
 *
 * Hai luật không được phá:
 *   1. Giá trị ngoài khoảng là LỖI, không phải "kẹp về biên rồi chạy tiếp". Kẹp im lặng biến
 *      `--devices 500` thành một lần chạy 100 thiết bị mà người gõ lệnh tưởng là 500 — mọi con
 *      số trong báo cáo sau đó đều bị hiểu sai.
 *   2. Tham số lạ là LỖI. Gõ nhầm `--devces 10` mà vẫn chạy với 1 thiết bị là cách chắc chắn
 *      nhất để một kịch bản "đạt" mà chẳng kiểm được gì.
 *
 * Module này KHÔNG gọi mạng và KHÔNG gọi process.exit: nó trả { ok, values } hoặc
 * { ok: false, error } để test gọi được trực tiếp.
 */

export const APP_VERSION = "sim-0.5.0";
export const SHIFTS = ["sang", "chieu", "dem"];

/* Dải cổng cho phép của cả track (05-virtual-devices.md §6). Dùng để cảnh báo khi --base trỏ
 * vào cổng dev thật (3000/5173/8000) — nhầm cổng là cách nhanh nhất để bắn 20 upload vào máy
 * chủ đang dùng để demo. */
export const PORT_RANGE = [39000, 39999];

/* KHÔNG CÓ CỔNG MẶC ĐỊNH — có chủ ý.
 *
 * Bản trước đặt DEFAULT_BASE = "http://127.0.0.1:39117". Cổng đó nằm TRONG dải 39000–39999 nên
 * isOutsideSimPortRange() không bao giờ kêu, mà nó lại đúng bằng cổng mà playbook bảo người
 * demo khởi động Main Backend. Hệ quả: `node scripts/sim/run-scenario.js backend-down-30s` gõ
 * thiếu --base sẽ hạ máy chủ của người khác trong 30 giây mà không một dòng cảnh báo nào.
 *
 * Nay `--base` là BẮT BUỘC: thiếu thì in hướng dẫn và thoát 2, không bao giờ tự nhắm vào một
 * cổng nào. isOutsideSimPortRange() vẫn giữ nguyên làm LỚP BẢO VỆ THỨ HAI cho cổng gõ nhầm.
 */
const MISSING_BASE_WHY = `Thiếu --base. Bộ công cụ mô phỏng KHÔNG còn cổng mặc định.

Vì sao: mặc định cũ (http://127.0.0.1:39117) nằm TRONG dải mô phỏng 39000–39999 nên rào chắn
cổng không bắn, mà đó lại đúng là cổng playbook bảo người demo dùng. Một lệnh gõ thiếu --base
sẽ âm thầm bắn tải — và với backend-down-30s là cả sim.set backend=down — vào máy chủ của
người khác.`;

export const MISSING_BASE_SCENARIO = `${MISSING_BASE_WHY}

Chọn một trong hai:
  1) Để hộp cát tự dựng máy chủ RIÊNG (cổng trống ngẫu nhiên + DATA_DIR tạm, tự dọn):
     node scripts/sim/sandbox.js --server-entry apps/server/src/index.js --scenario <tên>
  2) Hoặc nói rõ máy chủ đích:
     node scripts/sim/run-scenario.js <tên> --base http://127.0.0.1:<39000-39999>`;

export const MISSING_BASE_DEVICES = `${MISSING_BASE_WHY}

Nói rõ máy chủ đích (xem scripts/sim/README.md để dựng máy chủ riêng có DATA_DIR tạm):
     node scripts/sim/virtual-devices.js --base http://127.0.0.1:<39000-39999> …`;

const num = (raw) => {
  const s = String(raw).trim();
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
};

const DEVICE_SPEC = {
  base: { kind: "string", default: null },
  devices: { kind: "int", default: 1, range: [1, 100] },
  rate: { kind: "number", default: 6, range: [0, 600] },
  duration: { kind: "int", default: 30, range: [0, 3600] },
  "fail-rate": { kind: "number", default: 0, range: [0, 100], as: "failRate" },
  recognize: { kind: "flag", default: false },
  "recognize-only": { kind: "flag", default: false, as: "recognizeOnly" },
  uploads: { kind: "int", default: 0, range: [0, 500] },
  "same-label": { kind: "flag", default: false, as: "sameLabel" },
  prefix: { kind: "string", default: "VD" },
  seed: { kind: "int", default: 1, range: [0, 2147483647] },
  heartbeat: { kind: "int", default: 15000, range: [1000, 600000] },
  warehouse: { kind: "string", default: "WH01" },
  shift: { kind: "enum", default: "sang", options: SHIFTS },
  "no-session": { kind: "flag", default: false, as: "noSession" },
  image: { kind: "string", default: null },
  json: { kind: "flag", default: false },
  quiet: { kind: "flag", default: false },
  help: { kind: "flag", default: false },
};

const SCENARIO_SPEC = {
  base: { kind: "string", default: null },
  json: { kind: "flag", default: false },
  "keep-sim": { kind: "flag", default: false, as: "keepSim" },
  list: { kind: "flag", default: false },
  help: { kind: "flag", default: false },
};

const camel = (name, spec) => spec.as ?? name;

function defaults(spec) {
  const out = {};
  for (const [name, def] of Object.entries(spec)) out[camel(name, def)] = def.default;
  return out;
}

function coerce(name, def, raw) {
  if (def.kind === "string") {
    if (raw === "") return { error: `--${name} không được rỗng` };
    return { value: raw };
  }
  if (def.kind === "enum") {
    if (!def.options.includes(raw)) {
      return { error: `--${name} phải là một trong: ${def.options.join(", ")}, nhận "${raw}"` };
    }
    return { value: raw };
  }
  const n = num(raw);
  if (Number.isNaN(n)) return { error: `--${name} phải là số, nhận "${raw}"` };
  if (def.kind === "int" && !Number.isInteger(n)) return { error: `--${name} phải là số nguyên, nhận "${raw}"` };
  if (def.range && (n < def.range[0] || n > def.range[1])) {
    return { error: `--${name} phải trong khoảng ${def.range[0]}..${def.range[1]}, nhận "${raw}"` };
  }
  return { value: n };
}

/* Bộ phân tích dùng chung. positional=true thì token đầu không bắt đầu bằng "--" được giữ lại
 * ở values._positional; ngược lại nó là lỗi (gõ thừa một chữ cũng phải lộ ra). */
function parseWith(spec, argv, { positionals = 0 } = {}) {
  const values = defaults(spec);
  const seenPositional = [];
  const tokens = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i]);
    if (!token.startsWith("--")) {
      if (seenPositional.length < positionals) {
        seenPositional.push(token);
        continue;
      }
      return { ok: false, error: `Tham số không hiểu: ${token}` };
    }
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    const inlineValue = eq === -1 ? null : token.slice(eq + 1);
    const def = spec[name];
    if (!def) return { ok: false, error: `Tham số không hiểu: --${name}` };

    if (def.kind === "flag") {
      if (inlineValue !== null && inlineValue !== "true" && inlineValue !== "false") {
        return { ok: false, error: `--${name} là cờ bật/tắt, không nhận giá trị "${inlineValue}"` };
      }
      values[camel(name, def)] = inlineValue !== "false";
      continue;
    }

    let raw = inlineValue;
    if (raw === null) {
      const next = tokens[i + 1];
      /* Giá trị âm hợp lệ (không có ở spec hiện tại) sẽ bị luật này chặn — chấp nhận, vì
       * "--rate --json" gõ thiếu giá trị là lỗi phổ biến hơn nhiều. */
      if (next === undefined || String(next).startsWith("--")) {
        return { ok: false, error: `Tham số --${name} thiếu giá trị` };
      }
      raw = String(next);
      i += 1;
    }
    const out = coerce(name, def, raw);
    if (out.error) return { ok: false, error: out.error };
    values[camel(name, def)] = out.value;
  }

  return { ok: true, values, positional: seenPositional };
}

/* Kiểm tra liên-tham-số: từng giá trị hợp lệ nhưng tổ hợp thì vô nghĩa. */
function crossChecks(v) {
  /* Kiểm TRƯỚC mọi thứ khác: thiếu --base là thiếu sót nguy hiểm nhất trong cả bộ tham số. */
  if (v.base === null) return MISSING_BASE_DEVICES;
  if (v.recognize && v.recognizeOnly) {
    return "--recognize và --recognize-only loại trừ nhau: chọn một";
  }
  if (v.uploads > 0 && v.duration === 0) {
    return "--uploads đi với --duration 0 sẽ không bao giờ kết thúc: đặt --duration > 0";
  }
  let url;
  try {
    url = new URL(v.base);
  } catch {
    return `--base không phải URL hợp lệ: "${v.base}"`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `--base phải là http hoặc https, nhận "${url.protocol}"`;
  }
  return null;
}

export function parseArgs(argv = []) {
  const parsed = parseWith(DEVICE_SPEC, argv);
  if (!parsed.ok) return parsed;
  if (parsed.values.help) return { ok: true, values: parsed.values };
  const problem = crossChecks(parsed.values);
  if (problem) return { ok: false, error: problem };
  return { ok: true, values: parsed.values };
}

export function parseScenarioArgs(argv = []) {
  const parsed = parseWith(SCENARIO_SPEC, argv, { positionals: 1 });
  if (!parsed.ok) return parsed;
  const values = { ...parsed.values, scenario: parsed.positional[0] ?? null };
  if (values.help || values.list) return { ok: true, values };
  if (!values.scenario) {
    return { ok: false, error: "Thiếu tên kịch bản. Dùng --list để xem danh sách." };
  }
  if (values.base !== null) {
    try {
      const url = new URL(values.base);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, error: `--base phải là http hoặc https, nhận "${url.protocol}"` };
      }
    } catch {
      return { ok: false, error: `--base không phải URL hợp lệ: "${values.base}"` };
    }
  }
  return { ok: true, values };
}

/** true khi --base trỏ ra ngoài dải cổng 39000–39999 (cảnh báo, không phải lỗi). */
export function isOutsideSimPortRange(base) {
  try {
    const url = new URL(base);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return port < PORT_RANGE[0] || port > PORT_RANGE[1];
  } catch {
    return true;
  }
}

export const DEVICE_HELP = `Thiết bị ảo — mô phỏng N máy PDA nói chuyện với Main Backend qua HTTP.

  node scripts/sim/virtual-devices.js [tham số…]

  --base <url>          BẮT BUỘC — gốc Main Backend, cổng 39000–39999 (KHÔNG có mặc định)
  --devices <1..100>    số thiết bị ảo                          (1)
  --rate <n>            số phiếu mỗi thiết bị mỗi phút, 0 = chỉ heartbeat   (6)
  --duration <s>        thời gian chạy, 0 = tới khi Ctrl+C       (30)
  --fail-rate <0..100>  % phiếu cố tình thiếu partNumber để sinh 422        (0)
  --recognize           mỗi phiếu upload một ảnh trước khi lưu
  --recognize-only      chỉ upload ảnh, không lưu phiếu
  --uploads <n>         bắn đúng N upload đồng thời một lần rồi dừng        (0)
  --same-label          mọi thiết bị dùng cùng nhãn (kiểm rule trùng nhãn)
  --prefix <s>          tiền tố tên thiết bị                     (VD)
  --seed <n>            hạt giống PRNG                           (1)
  --heartbeat <ms>      chu kỳ heartbeat                         (15000)
  --warehouse <mã>      kho của phiên                            (WH01)
  --shift <ca>          sang | chieu | dem                       (sang)
  --no-session          không mở phiên làm việc
  --image <path>        dùng ảnh thật thay cho JPEG 1×1 dựng sẵn
  --json                in báo cáo JSON một dòng
  --quiet               chỉ in báo cáo cuối
  --help                in trợ giúp này

Mã thoát: 0 = không có lỗi khác lạ · 1 = có otherError · 2 = sai tham số.`;

export const SCENARIO_HELP = `Bộ chạy kịch bản — chạy một kịch bản rồi TỰ CHẤM đạt / không đạt.

  node scripts/sim/run-scenario.js <tên|đường/dẫn.json> [tham số…]

  --base <url>   BẮT BUỘC (trừ khi file kịch bản có baseUrl) — máy chủ đích, cổng 39000–39999.
                 Không muốn nghĩ về cổng? Dùng sandbox.js, nó tự dựng máy chủ riêng.
  --json         in báo cáo JSON một dòng
  --keep-sim     KHÔNG xoá kịch bản mô phỏng lúc kết thúc
  --list         liệt kê kịch bản có sẵn rồi thoát
  --help         in trợ giúp này

Mã thoát: 0 = ĐẠT (hoặc SKIPPED) · 1 = KHÔNG ĐẠT · 2 = lỗi tham số / không chạy được · 130 = Ctrl+C.`;
