/* Contract test — CP3.1 (Track DOCS).
 *
 * Kiểm rằng hợp đồng máy đọc được `docs/contracts/ocr-response.schema.json` khớp với **code thật**:
 *   - `recognizeWithLlm` (apps/ai-server/src/ocr.js) với một fetch LLM giả,
 *   - `recognizeSimulated` (apps/ai-server/src/sim.js) — đúng hàm mà `server.js` gọi khi `OCR_SIM_MODE`
 *     khác `passthrough`,
 *   - raw result của mock provider (apps/server/src/recognition/providers/mock.js).
 *
 * Nguyên tắc của file này: **không bao giờ tự chế payload rồi kiểm payload của chính mình.** Mọi dữ liệu
 * đưa vào validator đều là output của một hàm production. Tên mỗi test phải mô tả đúng điều nó thật sự
 * khẳng định — không rộng hơn.
 *
 * Cách chọn: import CHÉO WORKSPACE bằng đường dẫn tương đối (`../../ai-server/src/...`).
 * Hợp lệ vì cùng một repo, cùng `"type": "module"`, và không cần thêm dependency nào.
 * Không spawn ai-server qua HTTP: test phải chạy được khi không có mạng và không có OPENAI_API_KEY.
 *
 * File này KHÔNG dùng `apps/server/test/helpers.js` (file đó thuộc Track BE) — mọi helper nằm tại chỗ.
 * Validator JSON Schema nằm ở `./schema-validator.js` (cùng Track DOCS), xem phạm vi hỗ trợ tại đó.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validate } from "./schema-validator.js";
import { createMockProvider } from "../src/recognition/providers/mock.js";
import { mapAiResponse } from "../src/recognition/providers/http.js";
import { recognizeWithLlm, FIELD_SPECS } from "../../ai-server/src/ocr.js";
import { recognizeSimulated, OCR_SIM_MODES } from "../../ai-server/src/sim.js";
import { loadConfig } from "../../ai-server/src/config.js";

const SCHEMA_URL = new URL("../../../docs/contracts/ocr-response.schema.json", import.meta.url);
const schema = JSON.parse(fs.readFileSync(SCHEMA_URL, "utf8"));
const FIELD_NAMES = schema.properties.fields.items.properties.name.enum;

/* Schema nới `minItems` — CHỈ dùng cho mock provider (mock chỉ trả 8 trường, thiếu plant_dock
 * và batch). Không sửa schema gốc để chiều mock: schema mô tả contract của ai-server. */
const relaxed = structuredClone(schema);
relaxed.properties.fields.minItems = 1;

const ok = (data, s = schema) => {
  const r = validate(s, data);
  assert.equal(r.valid, true, `Không khớp schema:\n  ${r.errors.join("\n  ")}`);
};

/* Chat-completions giả: trả đúng shape OpenAI, không đi ra mạng. */
const LABEL = {
  part_number: "BEX32181030AB",
  part_name: "BATTERY_PACK_REAR_FENDER",
  qty: "80",
  ship_date: "18SEP2026",
  supplier: "VINFAST",
  sa_number: "5300013009",
  variant: "Limo Green",
  plant_dock: "3001/1001",
  batch: "260917_79F",
  gross_weight: "12,5",
};

function fakeLlmFetch({ content, model = "gpt-4o-mini", usage = { prompt_tokens: 37400, completion_tokens: 118, total_tokens: 37518 } } = {}) {
  const body = {
    model,
    usage,
    choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  };
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const llmContent = (overrides = {}) =>
  JSON.stringify({
    fields: FIELD_SPECS.map(({ name }) => ({ name, text: overrides[name] === undefined ? LABEL[name] : overrides[name], score: 0.9 })),
    raw_text: "VINFAST\nBEX32181030AB\nQTY 80",
  });

/* Gọi ai-server ở mức hàm: cùng dữ liệu mà createServer() bọc thành response /recognize. */
async function recognizeFake(content) {
  const config = loadConfig({ dotenv: false, apiKey: "sk-test-khong-that", baseUrl: "https://llm.invalid/v1", model: "gpt-4o-mini" });
  const result = await recognizeWithLlm({
    imageBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    mimeType: "image/jpeg",
    config,
    fetchImpl: fakeLlmFetch({ content }),
  });
  // Envelope giống hệt apps/ai-server/src/server.js: sendJson(res, 200, { recognitionId, durationMs, ...result })
  return { recognitionId: "218e4142-7a3b-4c11-9f0e-1b2c3d4e5f60", durationMs: 702, ...result };
}

/* Bọc output recognizeSimulated() thành ĐÚNG envelope mà apps/ai-server/src/server.js gửi đi ở
 * nhánh sim (server.js: sendJson(res, 200, { recognitionId, requestId, durationMs, model, simMode,
 * retryCount, fields, rawText, usage })). Nhờ vậy cái được validate là payload /recognize thật,
 * không phải nửa trong nửa ngoài. */
const simEnvelope = (mode, result) => ({
  recognitionId: "218e4142-7a3b-4c11-9f0e-1b2c3d4e5f60",
  requestId: "9f2a41c6-2e6b-4a13-b0a9-2f45a1f8b7c3",
  durationMs: 12,
  model: result.model,
  simMode: mode,
  retryCount: result.retryCount ?? 0,
  fields: result.fields,
  rawText: result.rawText,
  usage: result.usage ?? null,
});

/* Chạy đúng hàm production cho một mode. Abort sau ABORT_AFTER_MS để mode `timeout` (treo tới khi
 * signal abort) không làm treo cả bộ test; `ocrSimDelayMs: 0` để mode `slow` không chờ 25 s thật. */
const ABORT_AFTER_MS = 50;
async function runSimMode(mode) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ABORT_AFTER_MS);
  try {
    return { resolved: true, value: await recognizeSimulated({ mode, config: { ocrSimDelayMs: 0 }, signal: ac.signal }) };
  } catch (err) {
    return { resolved: false, error: err };
  } finally {
    clearTimeout(timer);
  }
}

const fieldOf = (result, name) => result.fields.find((f) => f.name === name);

/* --------------------------------------------------------------------------- */

test("schema-validator: bắt được thiếu required, sai type, key lạ, enum sai, mảng sai độ dài", () => {
  // Chứng minh validator KHÔNG phải hàm luôn trả true: mỗi ca dưới đây phải sinh đúng lỗi mong đợi.
  // Đây là dữ liệu dựng tay CÓ CHỦ Ý — đối tượng kiểm ở đây là validator, không phải code sim.
  const base = () => ({
    recognitionId: "r-1",
    durationMs: 100,
    model: "gpt-4o-mini",
    rawText: "",
    usage: null,
    fields: FIELD_NAMES.map((name) => ({ name, text: "x", score: 0.5 })),
  });

  const missing = base();
  delete missing.fields[0].text; // thiếu required
  let r = validate(schema, missing);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e === "/fields/0: thiếu key bắt buộc 'text'"), r.errors.join(" | "));

  const wrongType = base();
  wrongType.fields[2].text = 80; // text phải là string|null
  r = validate(schema, wrongType);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.startsWith("/fields/2/text: sai type, cần string|null")), r.errors.join(" | "));

  const tooBig = base();
  tooBig.fields[3].score = 5; // vượt maximum 1
  r = validate(schema, tooBig);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e === "/fields/3/score: 5 vượt maximum 1"), r.errors.join(" | "));

  const negative = base();
  negative.fields[4].score = -0.1;
  assert.equal(validate(schema, negative).valid, false);

  const strange = base();
  strange.fields[1].confidence = 0.9; // additionalProperties=false trong fields[]
  r = validate(schema, strange);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e === "/fields/1: key lạ 'confidence' (additionalProperties=false)"), r.errors.join(" | "));

  const badEnum = base();
  badEnum.fields[5].name = "part_no";
  r = validate(schema, badEnum);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.startsWith('/fields/5/name: "part_no" không thuộc enum')), r.errors.join(" | "));

  const short = base();
  short.fields = short.fields.slice(0, 7);
  r = validate(schema, short);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e === "/fields: mảng có 7 phần tử, cần tối thiểu 10"), r.errors.join(" | "));

  const long = base();
  long.fields = [...long.fields, { name: "batch", text: null, score: 0 }];
  assert.equal(validate(schema, long).valid, false);

  const noFields = base();
  delete noFields.fields;
  r = validate(schema, noFields);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e === ": thiếu key bắt buộc 'fields'"), r.errors.join(" | "));

  const badSimMode = base();
  badSimMode.simMode = "lowConfidence"; // không có trong enum simMode của ai-server
  assert.equal(validate(schema, badSimMode).valid, false);

  // additionalProperties=true ở cấp gốc: field lạ ở gốc KHÔNG bị coi là lỗi.
  const extraRoot = base();
  extraRoot.somethingNew = { a: 1 };
  assert.equal(validate(schema, extraRoot).valid, true);

  // Và bản chuẩn phải hợp lệ, nếu không thì mọi khẳng định trên đều vô nghĩa.
  assert.equal(validate(schema, base()).valid, true);
});

test("mock provider: raw result khớp ocr-response.schema.json khi nới minItems (mock chỉ trả 8/10 trường)", async () => {
  const provider = createMockProvider({ delayMs: 0 });
  const { raw, fields } = await provider.recognize({ image: { id: "img-1", mimeType: "image/jpeg", bytes: 148213 }, options: { mode: "success" } });

  // Mock chỉ trả 8 trường (thiếu plant_dock, batch) → validate bằng biến thể nới minItems.
  assert.equal(raw.fields.length, 8);
  ok(raw, relaxed);
  assert.equal(validate(schema, raw).valid, false, "schema gốc phải từ chối mock vì chưa đủ 10 trường");

  // Tên trường mock dùng phải nằm trong đúng enum của contract.
  for (const f of raw.fields) assert.ok(FIELD_NAMES.includes(f.name), `tên trường lạ: ${f.name}`);

  // Cùng raw đó phải ánh xạ được qua mapAiResponse của provider http (BE đọc được cả hai nguồn).
  const mapped = mapAiResponse(raw);
  assert.deepEqual(mapped.partNumber, { value: "BEX32181030AB", confidence: 0.94 });
  assert.equal(mapped.quantity.value, "80");
  assert.equal(mapped.grossWeight.value, "12,5");
  assert.deepEqual(Object.keys(mapped).sort(), Object.keys(fields).sort());
});

test("ai-server (recognizeWithLlm thật + fetch LLM giả): response /recognize khớp ocr-response.schema.json", async () => {
  const res = await recognizeFake(llmContent());
  ok(res);
  assert.equal(res.fields.length, 10);
  assert.deepEqual(res.fields.map((f) => f.name), FIELD_NAMES);
  assert.equal(res.model, "gpt-4o-mini");
  assert.equal(typeof res.rawText, "string");
  assert.equal(res.usage.total_tokens, 37518);

  // Ô trống trên nhãn: model trả null → text null, score 0. Vẫn đủ 10 phần tử.
  const withNulls = await recognizeFake(llmContent({ batch: null, plant_dock: null, variant: null }));
  ok(withNulls);
  assert.equal(withNulls.fields.length, 10);
  assert.equal(withNulls.fields.find((f) => f.name === "batch").text, null);
  assert.equal(withNulls.fields.find((f) => f.name === "batch").score, 0);

  // Kết quả thật của ai-server phải ánh xạ được sang key form của Main Backend.
  const mapped = mapAiResponse(res);
  assert.equal(mapped.partNumber.value, "BEX32181030AB");
  assert.equal(mapped.shipmentDate.value, "18SEP2026");
  assert.equal(mapped.plantDock.value, "3001/1001");
});

test("recognizeSimulated thật: mỗi mode trong OCR_SIM_MODES hoặc trả payload khớp schema, hoặc ném lỗi có cấu trúc", async () => {
  /* Đây là test DUY NHẤT được phép nói "mọi OCR_SIM_MODE": nó lặp trên chính hằng
   * OCR_SIM_MODES được export và gọi hàm production cho từng phần tử. Một mode mới do Track AI
   * thêm vào sẽ tự động được kiểm ở đây.
   *
   * Khẳng định theo TÍNH CHẤT chứ không theo con số cứng (bao nhiêu trường null, text cụ thể là gì),
   * để test không vỡ khi Track AI đổi dữ liệu mẫu SIM_SAMPLE_FIELDS. */

  // Enum simMode của hợp đồng phải phủ đúng tập mode của code — không thừa, không thiếu.
  assert.deepEqual(
    [...OCR_SIM_MODES].sort(),
    [...schema.properties.simMode.enum].sort(),
    "enum simMode trong ocr-response.schema.json lệch với OCR_SIM_MODES của apps/ai-server/src/sim.js",
  );

  const resolved = [];
  const rejected = [];
  for (const mode of OCR_SIM_MODES) {
    const r = await runSimMode(mode);
    if (!r.resolved) {
      // Lỗi phải là lỗi CÓ CẤU TRÚC (SimOcrError có .code, hoặc AbortError/TimeoutError của signal),
      // không phải TypeError do gọi sai hàm.
      assert.ok(r.error instanceof Error, `mode ${mode}: ném thứ không phải Error`);
      assert.ok(
        typeof r.error.code === "string" || ["AbortError", "TimeoutError"].includes(r.error.name),
        `mode ${mode}: lỗi không có .code và cũng không phải AbortError/TimeoutError (nhận ${r.error.name}: ${r.error.message})`,
      );
      rejected.push(mode);
      continue;
    }
    resolved.push(mode);

    const result = r.value;
    const payload = simEnvelope(mode, result);
    ok(payload); // ← đối chiếu payload /recognize THẬT với ocr-response.schema.json

    // Tính chất bắt buộc, độc lập với dữ liệu mẫu:
    assert.equal(result.fields.length, FIELD_NAMES.length, `mode ${mode}: phải giữ đủ ${FIELD_NAMES.length} trường`);
    for (const f of result.fields) {
      assert.ok(FIELD_NAMES.includes(f.name), `mode ${mode}: tên trường lạ '${f.name}'`);
      assert.ok(f.text === null || typeof f.text === "string", `mode ${mode}/${f.name}: text phải là string hoặc null`);
      assert.ok(typeof f.score === "number" && f.score >= 0 && f.score <= 1, `mode ${mode}/${f.name}: score phải thuộc [0,1]`);
    }
    assert.deepEqual(result.fields.map((f) => f.name), FIELD_NAMES, `mode ${mode}: thứ tự trường phải khớp enum của contract`);
    assert.equal(result.model, `sim-${mode}`, `mode ${mode}: model phải là "sim-<mode>" để log/DB phân biệt với model LLM thật`);
    assert.equal(result.usage, null, `mode ${mode}: mô phỏng không gọi LLM nên KHÔNG được có usage token`);
  }

  // Mode nào phải ném, mode nào phải trả 200 — theo hợp đồng Phase 3 §6.2 và apps/ai-server/src/server.js.
  assert.ok(resolved.includes("partial"), `partial phải trả payload 200; thực tế nằm trong nhóm ném lỗi: ${rejected.join(", ")}`);
  assert.ok(resolved.includes("garbage"), `garbage phải trả payload 200; thực tế nằm trong nhóm ném lỗi: ${rejected.join(", ")}`);
  assert.ok(resolved.includes("slow"), `slow (delay 0) phải trả payload 200; thực tế nằm trong nhóm ném lỗi: ${rejected.join(", ")}`);
  assert.ok(rejected.includes("error"), "error phải ném lỗi → ai-server trả 502 UPSTREAM_ERROR");
  assert.ok(rejected.includes("timeout"), "timeout phải treo tới khi abort rồi ném → ai-server trả 504 UPSTREAM_TIMEOUT");
  assert.ok(rejected.includes("passthrough"), "passthrough không được đi qua recognizeSimulated (phải gọi LLM thật)");
});

test("recognizeSimulated thật: partial xoá 3 trường bắt buộc, garbage làm qty không ép được sang số", async () => {
  /* Hai hiệu ứng nghiệp vụ mà demo dựa vào, kiểm bằng output THẬT:
   *  - partial → part_number/ship_date/supplier rỗng → BE đánh dấu "missing" (§6.2, Q6);
   *  - garbage → qty không parse được → BE đánh dấu "unparsed" (ĐÍNH CHÍNH R1 trong 01-contracts.md).
   * Không khẳng định "đúng N trường null": con số đó phụ thuộc dữ liệu mẫu của Track AI. */
  const partial = (await runSimMode("partial")).value;
  const garbage = (await runSimMode("garbage")).value;

  for (const name of ["part_number", "ship_date", "supplier"]) {
    assert.equal(fieldOf(partial, name).text, null, `partial: trường bắt buộc '${name}' phải bị xoá`);
    assert.equal(fieldOf(partial, name).score, 0, `partial: trường bị xoá phải có score 0`);
  }
  assert.ok(
    partial.fields.some((f) => typeof f.text === "string" && f.text !== ""),
    "partial phải GIỮ LẠI ít nhất một trường đọc được — nếu xoá sạch thì đó là mode 'rỗng', không phải 'partial'",
  );

  const qty = fieldOf(garbage, "qty");
  assert.ok(typeof qty.text === "string" && qty.text !== "", "garbage: qty phải là chuỗi rác, không phải null");
  assert.ok(!Number.isInteger(Number(qty.text)), `garbage: qty "${qty.text}" phải KHÔNG ép được sang integer → BE đặt status "unparsed"`);
  assert.ok(
    typeof fieldOf(garbage, "part_number").text === "string" && fieldOf(garbage, "part_number").text !== "",
    "garbage: part_number phải giữ một chuỗi (BE giữ giá trị để người vận hành sửa, chỉ kẹp confidence)",
  );

  // Rác vẫn phải đi lọt tầng ánh xạ của BE — service/fields.js mới là nơi đánh dấu unparsed.
  const mapped = mapAiResponse(simEnvelope("garbage", garbage));
  assert.equal(mapped.partNumber.value, fieldOf(garbage, "part_number").text);
  assert.equal(mapped.quantity.value, qty.text);
});

test("schema file đọc được, là JSON hợp lệ, có $schema draft-07 và đủ 10 enum tên trường", () => {
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.$id, "https://pda-scan.local/contracts/ocr-response.schema.json");
  assert.deepEqual(schema.required, ["fields"]);
  assert.equal(schema.additionalProperties, true);
  assert.equal(schema.properties.fields.items.additionalProperties, false);
  assert.equal(schema.properties.fields.minItems, 10);
  assert.equal(schema.properties.fields.maxItems, 10);

  assert.equal(FIELD_NAMES.length, 10);
  // Enum trong schema phải khớp TỪNG PHẦN TỬ, đúng thứ tự, với FIELD_SPECS của ai-server.
  assert.deepEqual(FIELD_NAMES, FIELD_SPECS.map((f) => f.name));
});

/* ═════════════════════════════════════════════════════════════════════════════════════════════
 * PHẦN 2 — Hợp đồng `docs/openapi.yaml` ↔ code thật của Main Backend.
 *
 * Lý do tồn tại: `docs/openapi.yaml` tự gọi mình là "nguồn máy đọc được", nhưng trước bộ test này
 * KHÔNG có một dòng mã nào trong repo mở file đó ra. Hệ quả đã xảy ra thật: file được bàn giao ở
 * commit `e685c1a` **không parse được** (hai lỗi cú pháp), và không ai biết cho tới khi có người
 * chạy tay một parser YAML.
 *
 * Nguyên tắc giữ nguyên từ PHẦN 1: **không tự chế dữ liệu rồi kiểm dữ liệu của chính mình.**
 *   - Danh sách route lấy từ `src/http.js`, `src/routes/master.js`, `src/routes/rules.js`.
 *   - Shape response lấy từ **BE thật đang chạy** (server nghe trên cổng 0 = cổng ngẫu nhiên do
 *     hệ điều hành cấp, `DATA_DIR` là thư mục tạm riêng — KHÔNG đụng `apps/server/data/`).
 *   - Không dùng `apps/server/test/helpers.js` (file của Track BE): helper nằm tại chỗ.
 *
 * Mỗi phép kiểm có một test CHIỀU ÂM đi kèm: cố tình làm hỏng đầu vào và khẳng định phép kiểm
 * BẮT được. Một validator không có chiều âm thì không chứng minh được nó đang làm gì.
 *
 * Khối `import` nằm ở ĐÂY, không ở đầu file: PHẦN 1 được giữ nguyên từng ký tự. ESM hoist import
 * nên vị trí không đổi hành vi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

import os from "node:os";
import path from "node:path";
import { before, after } from "node:test";
import { parseYamlSubset, YamlSyntaxError } from "./schema-validator.js";
import { loadConfig as loadServerConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { logger as serverLogger } from "../src/log.js";

const OPENAPI_URL = new URL("../../../docs/openapi.yaml", import.meta.url);
const OPENAPI_TEXT = fs.readFileSync(OPENAPI_URL, "utf8");

/* Parse LƯỜI, có bắt lỗi: nếu `docs/openapi.yaml` hỏng cú pháp thì mọi test dưới đây phải ĐỎ với
 * một câu giải thích đọc được, chứ không phải chết lúc nạp module kèm stack của parser. */
let openapiDoc = null;
let openapiError = null;
try {
  openapiDoc = parseYamlSubset(OPENAPI_TEXT);
} catch (err) {
  openapiError = err;
}
function openapiOrThrow() {
  if (openapiError) {
    throw new Error(`docs/openapi.yaml KHÔNG parse được — sửa file trước khi đọc hợp đồng: ${openapiError.message}`);
  }
  return openapiDoc;
}

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

/* ---------- 1. Rút route THẬT ra khỏi mã nguồn ---------- */

/* Mọi route đều khai đúng một dạng: `{ method: "GET", pattern: /^\/api\/…$/, handler … }`. */
const ROUTE_RE = /method:\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*pattern:\s*\/\^(.*?)\$\/\s*,/g;

function routesInSource(relPath) {
  const src = fs.readFileSync(new URL(relPath, import.meta.url), "utf8");
  const out = [];
  for (const m of src.matchAll(ROUTE_RE)) out.push({ method: m[1], regexBody: m[2], file: relPath.replace("../src/", "src/") });
  return out;
}

/* Regex route → đường dẫn kiểu OpenAPI với tham số ẩn danh: mọi nhóm bắt `(…)` thành `{}`. */
function pathFromRegex(regexBody) {
  return regexBody.replace(/\([^)]*\)(\{\d+(,\d+)?\})?/g, "{}").replace(/\\\//g, "/");
}
/* Đường dẫn OpenAPI → cùng dạng ẩn danh, để so khớp hai chiều. */
const anonymize = (openapiPath) => openapiPath.replace(/\{[^}]+\}/g, "{}");

const codeRoutes = [
  ...routesInSource("../src/http.js"),
  ...routesInSource("../src/routes/master.js"),
  ...routesInSource("../src/routes/rules.js"),
  /* admin.js là module route thứ ba được extraRoutes() nối vào (Phase 5). Quét cả nó, nếu không
   * phép đối chiếu sẽ lặng lẽ bỏ qua hai endpoint thật của màn hình giám sát. */
  ...routesInSource("../src/routes/admin.js"),
].map((r) => ({ ...r, path: pathFromRegex(r.regexBody), key: `${r.method} ${pathFromRegex(r.regexBody)}` }));

/* SỔ NỢ TÀI LIỆU của Phase 5 đã TRẢ XONG (2026-09-22): ba endpoint `POST /api/devices/:id/events`,
 * `GET /api/admin/events`, `GET /api/admin/recognitions` đã có mặt trong docs/openapi.yaml, nên
 * danh sách miễn trừ bị XOÁ hẳn thay vì để lại rỗng. Từ đây phép đối chiếu là TUYỆT ĐỐI: thêm một
 * route mà quên khai trong openapi.yaml, hoặc khai một operation không có route thật, đều làm
 * test ĐỎ — không còn cửa miễn trừ nào.
 * Hợp đồng đầy đủ của ba endpoint: docs/specs/phase-5/02-contracts-api.md §4.5, §4.6, §4.7. */

/* ---------- 2. Rút operation ra khỏi openapi.yaml ---------- */

function operationsOf(doc) {
  const out = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const m of HTTP_METHODS) {
      if (!item?.[m]) continue;
      out.push({ method: m.toUpperCase(), path: p, status: item[m]["x-status"] ?? null, key: `${m.toUpperCase()} ${anonymize(p)}` });
    }
  }
  return out;
}
const operations = () => operationsOf(openapiOrThrow());

/* Hai hàm THUẦN dưới đây là lõi của phép kiểm — test chiều âm gọi thẳng chúng với dữ liệu hỏng. */
const routesMissingFromSpec = (routes, ops) => {
  const have = new Set(ops.map((o) => o.key));
  return routes.filter((r) => !have.has(r.key)).map((r) => `${r.key}  (${r.file})`);
};
const opsWithoutRoute = (ops, routes) => {
  const have = new Set(routes.map((r) => r.key));
  return ops.filter((o) => o.status !== "planned" && !have.has(o.key)).map((o) => `${o.method} ${o.path}  (x-status: ${o.status})`);
};

/* ---------- 3. Giải `$ref` + `allOf` để dùng được validator JSON Schema của PHẦN 1 ---------- */

function deref(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => deref(n, seen));
  if (node === null || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return {}; // vòng lặp $ref → thôi ràng buộc, không treo test
    const target = node.$ref.replace(/^#\//, "").split("/").reduce((acc, k) => acc?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], openapiOrThrow());
    assert.ok(target, `openapi.yaml: $ref gãy → ${node.$ref}`);
    return deref(target, new Set([...seen, node.$ref]));
  }
  if (Array.isArray(node.allOf)) {
    const { allOf, ...rest } = node;
    return Object.assign({}, ...allOf.map((n) => deref(n, seen)), deref(rest, seen));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, seen)]));
}

const schemaOf = (name) => deref(openapiOrThrow().components.schemas[name]);
const okAgainst = (name, data, label) => {
  const r = validate(schemaOf(name), data);
  assert.equal(r.valid, true, `${label} KHÔNG khớp schema ${name}:\n  ${r.errors.join("\n  ")}`);
};

/* ---------- 4. BE thật, cổng ngẫu nhiên của hệ điều hành, DATA_DIR tạm riêng ---------- */

const DEVICE = "0d5c7f33-9d59-4d2e-8f11-0b3c9c0bd511";
let live = null;
let liveError = null;

before(async () => {
  try {
    live = await startLiveBackend();
  } catch (err) {
    /* BE không dựng được (ví dụ một track khác đang sửa dở `src/`) thì CHỈ các test cần BE mới đỏ;
     * 6 test PHẦN 1 và 8 test tĩnh của PHẦN 2 vẫn phải chạy và vẫn phải nói đúng sự thật. */
    liveError = err;
  }
});

async function startLiveBackend() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pda-contract-"));
  const config = loadServerConfig({
    dotenv: false,
    dataDir,
    dbPath: path.join(dataDir, "contract.sqlite"),
    uploadsDir: path.join(dataDir, "uploads"),
    mock: { delayMs: 0, slowDelayMs: 50, mode: "success" },
    simOverride: true,
    sap: { adapter: "none" },
    outbox: { enabled: false, tickMs: 20 },
    rules: { duplicate: false, location: false },
  });
  const app = buildApp(config, { logger: serverLogger.silent });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  return { app, dataDir, base: `http://127.0.0.1:${app.server.address().port}` };
}

after(async () => {
  if (!live) return;
  await new Promise((r) => live.app.server.close(r));
  live.app.close();
  fs.rmSync(live.dataDir, { recursive: true, force: true });
  live = null;
});

const call = async (method, p, body) => {
  if (!live) throw new Error(`Không dựng được BE để kiểm hợp đồng: ${liveError?.message ?? "lý do không rõ"}`);
  const res = await fetch(`${live.base}${p}`, {
    method,
    headers: { "x-device-id": DEVICE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

let seq = 0;
const newReceiptBody = () => ({
  requestId: `contract-${String(++seq).padStart(10, "0")}`,
  source: "manual",
  data: {
    partNumber: "BEX32181030AB",
    partName: "BATTERY_PACK_REAR_FENDER",
    quantity: 80,
    shipmentDate: "2026-09-18",
    supplier: "Nội bộ — Made in Vietnam",
    location: "A-01-01",
  },
  client: { warehouse: "Kho Long Biên", shift: "Ca 1" },
});

/* ═══════════════════ A. Cú pháp tệp openapi.yaml (lỗ hổng đã để lọt F-B16) ═══════════════════ */

test("openapi: docs/openapi.yaml đọc được bằng máy — parse sạch, ra đúng 26 path và 44 schema", () => {
  const doc = parseYamlSubset(OPENAPI_TEXT); // parse LẠI ở đây để lỗi cú pháp làm ĐỎ đúng test này
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(Object.keys(doc.paths).length, 26);
  assert.equal(Object.keys(doc.components.schemas).length, 44);
  assert.equal(operationsOf(doc).length, 30);
});

test("openapi: bộ kiểm cú pháp BẮT được 3 lớp lỗi YAML đã từng lọt vào openapi.yaml (chiều âm)", () => {
  const lines = OPENAPI_TEXT.split("\n");
  /* Tìm một dòng `key: giá trị` plain thật trong file để làm hỏng — không tự chế YAML giả. */
  const victim = lines.findIndex((l) => /^ {2,}title: /.test(l));
  assert.ok(victim > 0, "không tìm được dòng mẫu để làm hỏng");
  const indent = lines[victim].length - lines[victim].trimStart().length;

  const caught = (text) => {
    try {
      parseYamlSubset(text);
      return null;
    } catch (err) {
      return err;
    }
  };

  /* Lớp 1 — plain scalar chứa ": " (đúng lỗi dòng 1509 của bản e685c1a). */
  const c1 = [...lines];
  c1[victim] = `${" ".repeat(indent)}title: Mặc định "false" → chỉ trả vị trí active: true.`;
  const e1 = caught(c1.join("\n"));
  assert.ok(e1 instanceof YamlSyntaxError, "plain scalar chứa ': ' KHÔNG bị bắt → phép kiểm vô dụng");
  assert.equal(e1.line, victim + 1);
  assert.match(e1.reason, /plain scalar chứa/);

  /* Lớp 2 — ký tự cấu trúc `{` chưa bọc nháy bên trong flow mapping (đúng lỗi dòng 1244). */
  const c2 = [...lines];
  c2[victim] = `${" ".repeat(indent)}title: { type: object, description: Bỏ qua hoàn toàn. Gửi {}. }`;
  const e2 = caught(c2.join("\n"));
  assert.ok(e2 instanceof YamlSyntaxError, "flow mapping hỏng KHÔNG bị bắt → phép kiểm vô dụng");
  assert.equal(e2.line, victim + 1);
  assert.match(e2.reason, /flow mapping cần ',' hoặc '\}'/);

  /* Lớp 3 — thụt lề lệch. */
  const c3 = [...lines];
  c3.splice(victim + 1, 0, `${" ".repeat(indent + 3)}lạc-dòng: 1`);
  const e3 = caught(c3.join("\n"));
  assert.ok(e3 instanceof YamlSyntaxError, "thụt lề lệch KHÔNG bị bắt → phép kiểm vô dụng");
  assert.match(e3.reason, /thụt lề lệch/);

  /* Đối chứng: KHÔNG làm hỏng gì thì file phải parse sạch — chứng minh 3 lỗi trên là do bản vá,
   * không phải do bộ kiểm luôn ném lỗi. */
  assert.doesNotThrow(() => parseYamlSubset(lines.join("\n")));
});

/* ═══════════════════ B. openapi.yaml ↔ bảng route thật ═══════════════════ */

test("openapi: mọi đường dẫn /api/ trong http.js đều có mặt trong docs/openapi.yaml", () => {
  const fromHttp = codeRoutes.filter((r) => r.file === "src/http.js");
  assert.equal(fromHttp.length, 22, "số route đọc được từ http.js đổi — xem lại ROUTE_RE");
  assert.deepEqual(routesMissingFromSpec(fromHttp, operations()), []);
});

test("openapi: mọi route trong src/routes/master.js, rules.js và admin.js đều có mặt trong docs/openapi.yaml", () => {
  const fromRoutes = codeRoutes.filter((r) => r.file !== "src/http.js");
  assert.equal(fromRoutes.length, 7, "số route đọc được từ src/routes/ đổi — xem lại ROUTE_RE");
  assert.deepEqual(routesMissingFromSpec(fromRoutes, operations()), []);
});

test("openapi: chiều ngược lại — mọi operation không phải x-status planned đều có route thật trong apps/server/src", () => {
  assert.deepEqual(opsWithoutRoute(operations(), codeRoutes), []);
  /* 29 route thật = 26 của Phase 1-4 + 3 của Phase 5. Sổ nợ tài liệu đã trả xong, nên số
   * operation KHÔNG phải `planned` phải bằng ĐÚNG số route thật — không còn chênh lệch nào
   * được phép tồn tại. */
  assert.equal(codeRoutes.length, 29);
  assert.equal(operations().filter((o) => o.status !== "planned").length, 29);
  assert.equal(codeRoutes.length - operations().filter((o) => o.status !== "planned").length, 0);
});

test("openapi: phép đối chiếu route↔openapi BẮT được cả route thiếu lẫn operation thừa (chiều âm)", () => {
  const opsMissingEvents = operations().filter((o) => o.path !== "/api/receipts/{receiptId}/events");
  /* Bỏ một operation khỏi openapi thì route tương ứng PHẢI lộ ra — và CHỈ nó, vì không còn
   * danh sách miễn trừ nào. */
  assert.deepEqual(routesMissingFromSpec(codeRoutes, opsMissingEvents), ["GET /api/receipts/{}/events  (src/http.js)"]);

  const routesMissingCancel = codeRoutes.filter((r) => !r.path.endsWith("/cancel"));
  assert.deepEqual(opsWithoutRoute(operations(), routesMissingCancel), ["POST /api/receipts/{receiptId}/cancel  (x-status: phase-4)"]);

  /* Route "planned" không bị đòi hỏi phải tồn tại — đó là lý do /api/events được miễn. */
  assert.deepEqual(opsWithoutRoute(operations().filter((o) => o.path === "/api/events"), []), []);
});

test('openapi: không còn x-status "planned" cho 5 endpoint Phase 4 (events, retry-post, cancel, correct, master/locations)', () => {
  const five = [
    "GET /api/receipts/{receiptId}/events",
    "POST /api/receipts/{receiptId}/retry-post",
    "POST /api/receipts/{receiptId}/cancel",
    "POST /api/receipts/{receiptId}/correct",
    "GET /api/master/locations",
  ];
  for (const k of five) {
    const [method, p] = k.split(" ");
    const op = operations().find((o) => o.method === method && o.path === p);
    assert.ok(op, `openapi.yaml thiếu hẳn operation ${k}`);
    assert.equal(op.status, "phase-4", `${k} phải mang x-status: phase-4`);
  }
  const planned = operations().filter((o) => o.status === "planned");
  assert.deepEqual(planned.map((o) => `${o.method} ${o.path}`), ["GET /api/events"]);
});

/* ═══════════════════ C. Schema ↔ response thật của BE đang chạy ═══════════════════ */

test("openapi: ReceiptStatus enum đúng 8 giá trị và KHÔNG chứa draft/queued", () => {
  const e = openapiOrThrow().components.schemas.ReceiptStatus.enum;
  assert.deepEqual(e, ["confirmed", "posting", "posted", "post_failed", "rejected", "cancelled", "corrected", "superseded"]);
  assert.equal(e.length, 8);
  assert.equal(e.includes("draft"), false);
  assert.equal(e.includes("queued"), false);
});

test("openapi: schemas.Receipt required chứa đủ 7 field mới của Phase 4", () => {
  const req = openapiOrThrow().components.schemas.Receipt.required;
  const seven = ["status", "sapDocumentNo", "supersedesReceiptId", "supersededByReceiptId", "rejectCode", "postAttempts", "cancelReason"];
  assert.deepEqual(seven.filter((f) => !req.includes(f)), [], "thiếu field Phase 4 trong Receipt.required");
  assert.deepEqual(seven.filter((f) => !Object.hasOwn(openapiOrThrow().components.schemas.Receipt.properties, f)), []);
  assert.equal(req.length, 17);
});

test("openapi: schemas.Receipt.properties khớp ĐÚNG tập key của phiếu thật do POST /api/receipts trả về", async () => {
  const created = await call("POST", "/api/receipts", newReceiptBody());
  assert.equal(created.status, 201);

  const declared = Object.keys(openapiOrThrow().components.schemas.Receipt.properties).sort();
  const real = Object.keys(created.body).sort();
  assert.deepEqual(real, declared, "tập key của phiếu thật lệch khỏi Receipt.properties");

  /* `required` phải là lời hứa GIỮ ĐƯỢC: mọi field required phải thật sự có mặt. */
  const missing = openapiOrThrow().components.schemas.Receipt.required.filter((k) => !Object.hasOwn(created.body, k));
  assert.deepEqual(missing, []);
  okAgainst("Receipt", created.body, "POST /api/receipts (201)");

  /* Và cũng phải đúng trên đường đọc lại, không chỉ trên đường ghi. */
  const fetched = await call("GET", `/api/receipts/${created.body.receiptId}`);
  assert.equal(fetched.status, 200);
  okAgainst("Receipt", fetched.body, "GET /api/receipts/{receiptId}");
  assert.deepEqual(
    openapiOrThrow().components.schemas.Receipt.required.filter((k) => !Object.hasOwn(fetched.body, k)),
    [],
  );
});

test("openapi: validator BẮT được phiếu thiếu field Phase 4 và phiếu có status ngoài enum (chiều âm)", async () => {
  const created = await call("POST", "/api/receipts", newReceiptBody());
  assert.equal(created.status, 201);

  const { sapDocumentNo, ...thieuField } = created.body;
  const r1 = validate(schemaOf("Receipt"), thieuField);
  assert.equal(r1.valid, false, "validator KHÔNG thấy thiếu sapDocumentNo → vô dụng");
  assert.ok(r1.errors.some((e) => e.includes("sapDocumentNo")), r1.errors.join("; "));

  const r2 = validate(schemaOf("Receipt"), { ...created.body, status: "draft" });
  assert.equal(r2.valid, false, "validator KHÔNG thấy status='draft' ngoài enum → vô dụng");
  assert.ok(r2.errors.some((e) => e.includes("draft")), r2.errors.join("; "));

  const r3 = validate(schemaOf("Receipt"), { ...created.body, postAttempts: "0" });
  assert.equal(r3.valid, false, "validator KHÔNG thấy postAttempts sai type → vô dụng");
});

test("openapi: StatusResponse, ReceiptEvent, MasterLocation và Error khớp response thật của BE", async () => {
  const status = await call("GET", "/api/status");
  assert.equal(status.status, 200);
  /* openapi.yaml đã khai đủ 3 khoá Phase 5 (`queue.recognitionsPending`,
   * `queue.recognitionsFailedRecent`, khối `recognition`), nên body được kiểm NGUYÊN VẸN bằng
   * schema NGUYÊN VẸN: `additionalProperties: false` ở cả `StatusResponse`, `queue` và
   * `recognition` làm mọi khoá thừa — cũ lẫn mới — thành lỗi. */
  okAgainst("StatusResponse", status.body, "GET /api/status");
  assert.equal(typeof status.body.queue.recognitionsPending, "number");
  assert.equal(typeof status.body.queue.recognitionsFailedRecent, "number");
  assert.deepEqual(Object.keys(status.body.recognition).sort(), ["maxConcurrent", "maxWaiting", "mode", "pollHintMs", "timeoutMs"]);
  /* Chiều âm ngay tại chỗ: thêm một khoá lạ vào `recognition` phải bị schema bắt — nếu không,
   * dòng `okAgainst` ở trên chỉ là trang trí. */
  const withJunk = { ...status.body, recognition: { ...status.body.recognition, khoaLa: 1 } };
  assert.equal(validate(schemaOf("StatusResponse"), withJunk).valid, false, "schema KHÔNG bắt được khoá lạ trong recognition");

  const created = await call("POST", "/api/receipts", newReceiptBody());
  const events = await call("GET", `/api/receipts/${created.body.receiptId}/events`);
  assert.equal(events.status, 200);
  assert.deepEqual(Object.keys(events.body).sort(), ["items", "receiptId", "serverTime"]);
  assert.ok(events.body.items.length >= 1, "phiếu vừa tạo phải có ít nhất 1 dòng receipt_events");
  for (const ev of events.body.items) okAgainst("ReceiptEvent", ev, "GET …/events items[]");

  const locations = await call("GET", "/api/master/locations");
  assert.equal(locations.status, 200);
  assert.deepEqual(Object.keys(locations.body).sort(), ["items", "serverTime", "total", "truncated"]);
  assert.ok(locations.body.items.length >= 1);
  for (const loc of locations.body.items) okAgainst("MasterLocation", loc, "GET /api/master/locations items[]");

  const notFound = await call("GET", "/api/receipts/00000000-0000-4000-8000-000000000000");
  assert.equal(notFound.status, 404);
  okAgainst("Error", notFound.body, "404 NOT_FOUND");

  /* BE của test này chạy `SAP_ADAPTER=none`, nên `retry-post` trả đúng lỗi đã khai trong
   * openapi cho cấu hình đó. Điều được khẳng định là **shape Error**, không phải mã lỗi. */
  const retry = await call("POST", `/api/receipts/${created.body.receiptId}/retry-post`, {});
  assert.ok(retry.status >= 400, `retry-post phải là lỗi khi SAP_ADAPTER=none, nhận ${retry.status}`);
  okAgainst("Error", retry.body, `retry-post (${retry.status} ${retry.body.error.code})`);
  const declaredCodes = Object.keys(openapiOrThrow().paths["/api/receipts/{receiptId}/retry-post"].post.responses);
  assert.ok(declaredCodes.includes(String(retry.status)), `openapi chưa khai response ${retry.status} cho retry-post (đã khai: ${declaredCodes.join(", ")})`);
});

/* ═══════════════════ D. Ba endpoint Phase 5 — schema ↔ response thật ═══════════════════
 *
 * Phần này ra đời cùng lúc với việc TRẢ XONG sổ nợ tài liệu Phase 5. Khai ba endpoint vào
 * openapi.yaml mà không đối chiếu với response thật thì mới chỉ chuyển món nợ từ "thiếu hẳn"
 * sang "có nhưng sai" — kiểu nợ khó phát hiện hơn nhiều. */

test("openapi: ba operation mới của Phase 5 có mặt, mang đúng x-status phase-5", () => {
  const three = ["POST /api/devices/{deviceId}/events", "GET /api/admin/events", "GET /api/admin/recognitions"];
  for (const k of three) {
    const [method, p] = k.split(" ");
    const op = operations().find((o) => o.method === method && o.path === p);
    assert.ok(op, `openapi.yaml thiếu hẳn operation ${k}`);
    assert.equal(op.status, "phase-5", `${k} phải mang x-status: phase-5`);
  }
});

test("openapi: schemas.SystemEvent khớp ĐÚNG tập key của dòng sự kiện thật do GET /api/admin/events trả về", async () => {
  const posted = await call("POST", `/api/devices/${DEVICE}/events`, {
    events: [
      { type: "device.camera_error", at: "2026-09-22T03:14:05.100Z", detail: { name: "NotAllowedError" } },
      { type: "device.queue_enqueued", detail: { reason: "OFFLINE", size: 3 } },
    ],
  });
  assert.equal(posted.status, 202);
  assert.deepEqual(Object.keys(posted.body).sort(), ["accepted", "rejected", "serverTime"]);
  assert.equal(posted.body.accepted, 2);
  assert.equal(posted.body.rejected, 0);

  const list = await call("GET", "/api/admin/events?since=0&limit=50");
  assert.equal(list.status, 200);
  /* Khoá SỐ KHOÁ của response ở HAI đầu: danh sách chép tay (đổi hợp đồng phải là việc có ý
   * thức) và chính `properties` của openapi.yaml (hai bên không được trôi khỏi nhau). */
  const EXPECTED_KEYS = ["hasMore", "items", "lastId", "oldestId", "serverTime"];
  assert.deepEqual(Object.keys(list.body).sort(), EXPECTED_KEYS);
  const listSchema = openapiOrThrow().paths["/api/admin/events"].get.responses["200"].content["application/json"].schema;
  assert.deepEqual(Object.keys(listSchema.properties).sort(), EXPECTED_KEYS, "openapi.yaml lệch khỏi response thật");
  assert.deepEqual([...listSchema.required].sort(), EXPECTED_KEYS, "mọi khoá phải là required, không có khoá tuỳ nghi");
  assert.equal(listSchema.additionalProperties, false);
  assert.ok(list.body.items.length >= 2, "vừa ghi 2 sự kiện mà sổ sự kiện không có dòng nào");

  /* `oldestId` là MIN(id) thật của bảng — số nguyên, không phải null, không phải chuỗi.
   * BE này vừa dựng trên DB rỗng và còn xa `EVENTS_MAX_ROWS` (2000), nên chưa có nhịp cắt
   * nào: dòng đầu tiên từng ghi vẫn còn, tức oldestId đúng bằng 1. Nhánh ĐÃ BỊ CẮT được
   * kiểm ở `events.test.js` và ở `be-fe-seam.test.js` với maxRows nhỏ. */
  assert.equal(typeof list.body.oldestId, "number");
  assert.equal(list.body.oldestId, 1, "bảng chưa bị vòng xoay cắt lần nào thì sàn phải là id 1");
  assert.ok(list.body.oldestId <= Math.min(...list.body.items.map((e) => e.id)), "oldestId không thể lớn hơn dòng đang thấy");

  const declared = Object.keys(openapiOrThrow().components.schemas.SystemEvent.properties).sort();
  for (const ev of list.body.items) {
    assert.deepEqual(Object.keys(ev).sort(), declared, "tập key của dòng sự kiện thật lệch khỏi SystemEvent.properties");
    okAgainst("SystemEvent", ev, "GET /api/admin/events items[]");
  }
  /* Thứ tự TĂNG DẦN là một khẳng định của hợp đồng, không phải chi tiết hiện thực. */
  const ids = list.body.items.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "items không theo thứ tự id tăng dần");
  assert.equal(list.body.lastId, ids[ids.length - 1]);

  /* `since` sai là lỗi DUY NHẤT của endpoint này — các bộ lọc khác chỉ bị bỏ qua. */
  const bad = await call("GET", "/api/admin/events?since=abc");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "INVALID_SINCE");
  okAgainst("Error", bad.body, "400 INVALID_SINCE");

  const lenient = await call("GET", "/api/admin/events?severity=khong-co-that&deviceId=khong-phai-uuid");
  assert.equal(lenient.status, 200, "bộ lọc sai phải bị BỎ QUA, không phải báo lỗi");
});

test("openapi: loại sự kiện ngoài danh sách trắng bị từ chối cả lô với INVALID_EVENT_TYPE (chiều âm)", async () => {
  const before = await call("GET", "/api/admin/events?since=0&limit=200");
  const rejected = await call("POST", `/api/devices/${DEVICE}/events`, {
    events: [{ type: "device.battery_low", detail: { level: 0.12 } }, { type: "receipt.posted" }],
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "INVALID_EVENT_TYPE");
  assert.deepEqual(rejected.body.error.details.allowed, openapiOrThrow().components.schemas.ClientEventType.enum);
  okAgainst("Error", rejected.body, "400 INVALID_EVENT_TYPE");

  /* "Cả lô hoặc không gì cả": phần tử HỢP LỆ đứng trước cũng KHÔNG được ghi. */
  const after = await call("GET", "/api/admin/events?since=0&limit=200");
  assert.equal(after.body.lastId, before.body.lastId, "một phần tử của lô đã bị ghi dù lô bị từ chối");

  const empty = await call("POST", `/api/devices/${DEVICE}/events`, { events: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, "INVALID_BODY");
  assert.equal(empty.body.error.details.max, openapiOrThrow().components.schemas.DeviceEventBatch.properties.events.maxItems);
});

test("openapi: schemas.AdminRecognition khớp ĐÚNG tập key của GET /api/admin/recognitions, và counts đếm toàn bảng", async () => {
  const res = await call("GET", "/api/admin/recognitions?limit=100");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["counts", "items", "serverTime"]);
  assert.deepEqual(Object.keys(res.body.counts).sort(), ["completed", "failed", "pending"]);

  const declared = Object.keys(openapiOrThrow().components.schemas.AdminRecognition.properties).sort();
  for (const item of res.body.items) {
    assert.deepEqual(Object.keys(item).sort(), declared, "tập key của dòng nhận dạng thật lệch khỏi AdminRecognition.properties");
    okAgainst("AdminRecognition", item, "GET /api/admin/recognitions items[]");
    assert.equal(Object.hasOwn(item, "fields"), false, "endpoint giám sát KHÔNG được trả dữ liệu nhãn");
  }

  /* counts đếm TOÀN BẢNG: thu hẹp `limit` không được làm nó đổi. */
  const narrow = await call("GET", "/api/admin/recognitions?limit=1");
  assert.deepEqual(narrow.body.counts, res.body.counts);
  /* `status` lạ chỉ bị bỏ qua, không phải lỗi. */
  const lenient = await call("GET", "/api/admin/recognitions?status=khong-co-that&limit=9999");
  assert.equal(lenient.status, 200);
  assert.ok(lenient.body.items.length <= 100, "limit phải được kẹp về trần 100");
});
