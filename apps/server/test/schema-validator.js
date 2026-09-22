/* Validator JSON Schema draft-07 **rút gọn**, tự viết, 0 dependency npm (chỉ `node:` builtin).
 *
 * Vì sao tự viết: repo có nguyên tắc "không thêm dependency npm" cho Main Backend, mà test contract
 * vẫn phải đối chiếu output code thật với `docs/contracts/ocr-response.schema.json`. Phạm vi hỗ trợ
 * được cắt vừa đủ cho đúng file schema đó, không nhằm thay thế ajv.
 *
 * Hỗ trợ:
 *   - `type` (kể cả mảng type, ví dụ `["string","null"]`)
 *   - `required`, `properties`, `additionalProperties: false`
 *   - `items` (schema đơn — KHÔNG hỗ trợ dạng tuple), `minItems`, `maxItems`
 *   - `enum`, `minimum`, `maximum`, `pattern`
 *
 * KHÔNG hỗ trợ (bỏ qua **im lặng**, không báo lỗi):
 *   `$ref`, `oneOf`/`anyOf`/`allOf`/`not`, `format`, `dependencies`, `patternProperties`,
 *   `const`, `multipleOf`, `uniqueItems`, `items` dạng tuple.
 *
 * Hệ quả: một schema dùng những từ khoá trên sẽ được validator này coi là "không ràng buộc" —
 * dùng ngoài phạm vi test contract nội bộ là sai.
 *
 * Mọi lỗi trả về đều mở đầu bằng JSON Pointer (RFC 6901) tới đúng chỗ sai, ví dụ
 * `/fields/2/text: sai type, cần string|null, nhận number`.
 */

const TYPE_OK = {
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const esc = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

function walk(schema, data, ptr, errors) {
  if (!schema || typeof schema !== "object") return;
  const at = ptr === "" ? "" : ptr;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPE_OK[t]?.(data))) {
      errors.push(`${at}: sai type, cần ${types.join("|")}, nhận ${describe(data)}`);
      return; // các kiểm tra sau đó vô nghĩa khi type đã sai
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errors.push(`${at}: ${JSON.stringify(data)} không thuộc enum [${schema.enum.join(", ")}]`);
  }
  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) errors.push(`${at}: ${data} nhỏ hơn minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && data > schema.maximum) errors.push(`${at}: ${data} vượt maximum ${schema.maximum}`);
  }
  if (typeof data === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${at}: "${data}" không khớp pattern ${schema.pattern}`);
  }
  if (Array.isArray(data)) {
    if (Number.isInteger(schema.minItems) && data.length < schema.minItems) errors.push(`${at}: mảng có ${data.length} phần tử, cần tối thiểu ${schema.minItems}`);
    if (Number.isInteger(schema.maxItems) && data.length > schema.maxItems) errors.push(`${at}: mảng có ${data.length} phần tử, cần tối đa ${schema.maxItems}`);
    if (schema.items && !Array.isArray(schema.items)) data.forEach((item, i) => walk(schema.items, item, `${at}/${i}`, errors));
  }
  if (TYPE_OK.object(data)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(data, key)) errors.push(`${at}: thiếu key bắt buộc '${key}'`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!Object.hasOwn(props, key)) errors.push(`${at}: key lạ '${key}' (additionalProperties=false)`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(data, key)) walk(sub, data[key], `${at}/${esc(key)}`, errors);
    }
  }
}

/**
 * Đối chiếu `data` với `schema`.
 * @param {object} schema  JSON Schema draft-07 (trong phạm vi từ khoá nêu ở đầu file).
 * @param {unknown} data   Dữ liệu cần kiểm.
 * @returns {{ valid: boolean, errors: string[] }} `errors[i]` mở đầu bằng JSON Pointer để debug.
 */
export function validate(schema, data) {
  const errors = [];
  walk(schema, data, "", errors);
  return { valid: errors.length === 0, errors };
}

/* ═════════════════════════════════════════════════════════════════════════════════════════════
 * Bộ kiểm cú pháp YAML (TẬP CON) — dùng để đọc `docs/openapi.yaml` bằng máy, 0 dependency npm.
 *
 * Vì sao tự viết thay vì thêm `js-yaml`: repo giữ nguyên tắc **zero npm dependency** cho
 * `apps/server` (`apps/server/package.json` không có khối `dependencies`/`devDependencies`), và
 * Node 22 không có parser YAML sẵn. Đánh đổi đã chọn: bộ này **chặt hơn** YAML thật — gặp cấu
 * trúc ngoài tập con thì NÉM LỖI thay vì đoán. Với một file hợp đồng do người viết tay, "chặt hơn"
 * là tính năng: nó biến mọi chỗ mơ hồ thành lỗi CI thay vì thành hiểu nhầm im lặng.
 *
 * Hỗ trợ: block mapping · block sequence (kể cả dạng gọn `- key: value`) · flow mapping `{}` ·
 * flow sequence `[]` · scalar nháy đơn/nháy kép · block scalar `|` `>` (kèm `-`/`+`/số thụt lề) ·
 * chú thích `#` · ép kiểu `true/false/null/~`/số.
 *
 * KHÔNG hỗ trợ (ném `YamlSyntaxError`): anchor `&`/alias `*`/tag `!` · nhiều document (`---`) ·
 * khoá tường minh `? ` · plain scalar nhiều dòng · tab ở phần thụt lề · khoá trùng trong cùng
 * một mapping.
 *
 * Ba lớp lỗi bộ này được viết ra để BẮT (đã từng lọt vào `docs/openapi.yaml`):
 *   1. plain scalar chứa `": "` → YAML thật hiểu thành mapping lồng, file hỏng từ dòng đó.
 *   2. flow mapping/sequence chứa ký tự cấu trúc `{ } [ ] : ,` không bọc nháy.
 *   3. thụt lề lệch (một dòng con không thẳng hàng với khối đang mở).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export class YamlSyntaxError extends Error {
  constructor(reason, line, column) {
    super(`YAML lỗi cú pháp tại dòng ${line}, cột ${column}: ${reason}`);
    this.name = "YamlSyntaxError";
    this.reason = reason;
    this.line = line; // 1-based
    this.column = column; // 1-based
  }
}

const INT_RE = /^-?(0|[1-9]\d*)$/;
const FLOAT_RE = /^-?(0|[1-9]\d*)\.\d+([eE][+-]?\d+)?$/;

/* Ép kiểu một plain scalar ĐÃ hợp lệ. Cố ý hẹp: "3.1.0" và "0.4.0" phải ở lại dạng chuỗi. */
function coerce(raw) {
  if (raw === "" || raw === "~" || raw === "null" || raw === "Null" || raw === "NULL") return null;
  if (raw === "true" || raw === "True" || raw === "TRUE") return true;
  if (raw === "false" || raw === "False" || raw === "FALSE") return false;
  if (INT_RE.test(raw) || FLOAT_RE.test(raw)) return Number(raw);
  return raw;
}

const leadingSpaces = (s) => s.length - s.replace(/^ +/, "").length;
const isBlankLine = (s) => s.trim() === "";
const isCommentLine = (s) => s.trimStart().startsWith("#");

/* Cắt chú thích cuối dòng của một plain scalar: chỉ ` #` (khoảng trắng rồi #) mới mở chú thích. */
function stripTrailingComment(s) {
  const i = s.search(/\s#/);
  return i === -1 ? s : s.slice(0, i);
}

/* ---------- scalar nháy ---------- */

/* Đọc một scalar bọc nháy bắt đầu tại s[i]. Trả { value, end }. */
function readQuoted(s, i, ln, colBase) {
  const quote = s[i];
  let j = i + 1;
  let out = "";
  while (j < s.length) {
    const c = s[j];
    if (quote === "'") {
      if (c === "'") {
        if (s[j + 1] === "'") { out += "'"; j += 2; continue; }
        return { value: out, end: j + 1 };
      }
      out += c; j += 1; continue;
    }
    if (c === "\\") {
      const n = s[j + 1];
      if (n === undefined) break;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
      j += 2; continue;
    }
    if (c === '"') return { value: out, end: j + 1 };
    out += c; j += 1;
  }
  throw new YamlSyntaxError(`chuỗi mở bằng ${quote} không được đóng trước hết dòng`, ln.no, colBase + i + 1);
}

/* ---------- nút flow (một dòng) ---------- */

const FLOW_STRUCT = new Set(["{", "}", "[", "]", ","]);

function flowSkipWs(p) {
  while (p.i < p.s.length && (p.s[p.i] === " " || p.s[p.i] === "\t")) p.i += 1;
}

/* Trong flow context, `:` chỉ là ký tự cấu trúc khi SAU nó là khoảng trắng / `,` / `}` / `]` /
 * hết dòng. Nhờ vậy `device:<id>` vẫn là một scalar (giống YAML thật), còn `a: b` thì không. */
function flowColonEnds(s, i) {
  if (s[i] !== ":") return false;
  const n = s[i + 1];
  return n === undefined || n === " " || n === "\t" || n === "," || n === "}" || n === "]";
}

function flowScalar(p, ln, colBase) {
  flowSkipWs(p);
  const c = p.s[p.i];
  if (c === "'" || c === '"') {
    const { value, end } = readQuoted(p.s, p.i, ln, colBase);
    p.i = end;
    return value;
  }
  const start = p.i;
  while (p.i < p.s.length && !FLOW_STRUCT.has(p.s[p.i]) && !flowColonEnds(p.s, p.i)) p.i += 1;
  const raw = p.s.slice(start, p.i).trim();
  if (raw === "") {
    throw new YamlSyntaxError(`chờ một giá trị nhưng gặp '${p.s[p.i] ?? "hết dòng"}'`, ln.no, colBase + p.i + 1);
  }
  if (/\s#/.test(raw)) {
    throw new YamlSyntaxError("plain scalar trong flow chứa ' #' — YAML sẽ cắt thành chú thích; hãy bọc nháy", ln.no, colBase + start + 1);
  }
  return coerce(raw);
}

function flowNode(p, ln, colBase) {
  flowSkipWs(p);
  const c = p.s[p.i];
  if (c === "{") {
    p.i += 1;
    const out = {};
    flowSkipWs(p);
    if (p.s[p.i] === "}") { p.i += 1; return out; }
    for (;;) {
      flowSkipWs(p);
      const keyCol = colBase + p.i + 1;
      const key = flowScalar(p, ln, colBase);
      flowSkipWs(p);
      if (p.s[p.i] !== ":") {
        throw new YamlSyntaxError(`trong flow mapping, sau khoá '${key}' cần ':' nhưng gặp '${p.s[p.i] ?? "hết dòng"}'`, ln.no, colBase + p.i + 1);
      }
      p.i += 1;
      const value = flowNode(p, ln, colBase);
      if (Object.hasOwn(out, String(key))) {
        throw new YamlSyntaxError(`khoá trùng '${key}' trong flow mapping`, ln.no, keyCol);
      }
      out[String(key)] = value;
      flowSkipWs(p);
      const t = p.s[p.i];
      if (t === ",") { p.i += 1; flowSkipWs(p); if (p.s[p.i] === "}") { p.i += 1; return out; } continue; }
      if (t === "}") { p.i += 1; return out; }
      throw new YamlSyntaxError(`trong flow mapping cần ',' hoặc '}' nhưng gặp '${t ?? "hết dòng"}' — ký tự cấu trúc chưa bọc nháy?`, ln.no, colBase + p.i + 1);
    }
  }
  if (c === "[") {
    p.i += 1;
    const out = [];
    flowSkipWs(p);
    if (p.s[p.i] === "]") { p.i += 1; return out; }
    for (;;) {
      out.push(flowNode(p, ln, colBase));
      flowSkipWs(p);
      const t = p.s[p.i];
      if (t === ",") { p.i += 1; flowSkipWs(p); if (p.s[p.i] === "]") { p.i += 1; return out; } continue; }
      if (t === "]") { p.i += 1; return out; }
      throw new YamlSyntaxError(`trong flow sequence cần ',' hoặc ']' nhưng gặp '${t ?? "hết dòng"}' — ký tự cấu trúc chưa bọc nháy?`, ln.no, colBase + p.i + 1);
    }
  }
  if (c === "{" || c === "[") return undefined; // không tới được
  return flowScalar(p, ln, colBase);
}

/* Toàn bộ phần còn lại của dòng phải là MỘT nút flow (cho phép chú thích đuôi). */
function parseFlowLine(rest, ln, colBase) {
  const p = { s: rest, i: 0 };
  const v = flowNode(p, ln, colBase);
  flowSkipWs(p);
  const tail = p.s.slice(p.i).trim();
  if (tail !== "" && !tail.startsWith("#")) {
    throw new YamlSyntaxError(`thừa ký tự '${tail}' sau nút flow`, ln.no, colBase + p.i + 1);
  }
  return v;
}

/* ---------- block scalar ---------- */

const BLOCK_HEADER_RE = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/;

function readBlockScalar(L, cur, parentIndent, header, ln) {
  const m = BLOCK_HEADER_RE.exec(header.trim());
  if (!m) throw new YamlSyntaxError(`đầu block scalar không hợp lệ: '${header.trim()}'`, ln.no, parentIndent + 1);
  const style = m[1];
  const chomp = m[2] || m[4] || "";
  const explicit = m[3] ? Number(m[3]) : 0;

  const body = [];
  let contentIndent = explicit ? parentIndent + explicit : -1;
  while (cur.idx < L.length) {
    const t = L[cur.idx].text;
    if (isBlankLine(t)) { body.push(""); cur.idx += 1; continue; }
    const ind = leadingSpaces(t);
    if (contentIndent === -1) {
      if (ind <= parentIndent) break;
      contentIndent = ind;
    }
    if (ind < contentIndent) break;
    body.push(t.slice(contentIndent));
    cur.idx += 1;
  }
  while (body.length && body[body.length - 1] === "") body.pop();

  let text;
  if (style === "|") {
    text = body.join("\n");
  } else {
    /* Gấp dòng rút gọn: dòng rỗng → xuống dòng thật; dòng liền nhau → nối bằng khoảng trắng.
     * Đủ cho việc đối chiếu cấu trúc; KHÔNG dùng để so khớp từng ký tự nội dung `>`. */
    const parts = [];
    for (const lineText of body) {
      if (lineText === "") { parts.push("\n"); continue; }
      if (parts.length && parts[parts.length - 1] !== "\n") parts.push(" ");
      parts.push(lineText);
    }
    text = parts.join("");
  }
  if (chomp === "-") return text;
  if (chomp === "+") return text + "\n";
  return text === "" ? "" : text + "\n";
}

/* ---------- tách khoá của một dòng mapping ---------- */

function splitKey(body, ln, indent) {
  if (body[0] === "'" || body[0] === '"') {
    const { value, end } = readQuoted(body, 0, ln, indent);
    const after = body.slice(end);
    if (after[0] !== ":") throw new YamlSyntaxError("sau khoá bọc nháy phải là ':'", ln.no, indent + end + 1);
    return { key: value, rest: after.slice(1) };
  }
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== ":") continue;
    const next = body[i + 1];
    if (next === undefined || next === " ") {
      const key = body.slice(0, i).trim();
      if (key === "") throw new YamlSyntaxError("khoá rỗng", ln.no, indent + 1);
      if (key.startsWith("- ")) throw new YamlSyntaxError("gặp phần tử dãy '-' giữa một khối mapping", ln.no, indent + 1);
      return { key, rest: body.slice(i + 1) };
    }
  }
  throw new YamlSyntaxError(`dòng không phải 'khoá: giá trị' và cũng không phải phần tử dãy: '${body.trim().slice(0, 60)}'`, ln.no, indent + 1);
}

/* ---------- giá trị đứng sau 'khoá:' hoặc '- ' ---------- */

function parseInlineValue(L, cur, indent, rest, ln) {
  const colBase = ln.text.length - rest.length; // số cột đã tiêu thụ trước `rest`
  const trimmed = rest.trim();

  if (trimmed === "" || trimmed.startsWith("#")) {
    const nxt = nextContent(L, cur);
    if (!nxt) return null;
    const ind = leadingSpaces(nxt.text);
    if (ind <= indent) return null;
    return parseBlock(L, cur, ind);
  }
  if (trimmed[0] === "|" || trimmed[0] === ">") return readBlockScalar(L, cur, indent, trimmed, ln);
  if (trimmed[0] === "&" || trimmed[0] === "*" || trimmed[0] === "!") {
    throw new YamlSyntaxError(`anchor/alias/tag '${trimmed[0]}' nằm ngoài tập con được hỗ trợ`, ln.no, colBase + leadingSpaces(rest) + 1);
  }
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    return parseFlowLine(rest.trimStart(), ln, colBase + leadingSpaces(rest));
  }
  if (trimmed[0] === "'" || trimmed[0] === '"') {
    const src = rest.trimStart();
    const { value, end } = readQuoted(src, 0, ln, colBase + leadingSpaces(rest));
    const tail = src.slice(end).trim();
    if (tail !== "" && !tail.startsWith("#")) {
      throw new YamlSyntaxError(`thừa ký tự '${tail.slice(0, 40)}' sau chuỗi bọc nháy`, ln.no, colBase + leadingSpaces(rest) + end + 1);
    }
    return value;
  }

  /* plain scalar — nơi sinh ra lớp lỗi số 1 */
  const plain = stripTrailingComment(rest).trim();
  const bad = plain.indexOf(": ");
  if (bad !== -1 || plain.endsWith(":")) {
    const col = colBase + leadingSpaces(rest) + (bad === -1 ? plain.length : bad) + 1;
    throw new YamlSyntaxError(
      "plain scalar chứa \": \" (hoặc kết thúc bằng ':') — YAML sẽ hiểu thành mapping lồng; hãy bọc giá trị trong nháy đơn",
      ln.no,
      col,
    );
  }
  /* plain scalar nhiều dòng không được hỗ trợ: dòng kế thụt sâu hơn sẽ bị parseBlock báo lệch thụt lề. */
  return coerce(plain);
}

/* ---------- con trỏ dòng ---------- */

function nextContent(L, cur) {
  while (cur.idx < L.length) {
    const t = L[cur.idx].text;
    if (isBlankLine(t) || isCommentLine(t)) { cur.idx += 1; continue; }
    return L[cur.idx];
  }
  return null;
}

function parseMapping(L, cur, indent) {
  const out = {};
  for (;;) {
    const ln = nextContent(L, cur);
    if (!ln) break;
    const ind = leadingSpaces(ln.text);
    if (ind < indent) break;
    if (ind > indent) {
      throw new YamlSyntaxError(`thụt lề lệch: dòng thụt ${ind} dấu cách trong khối đang mở ở ${indent}`, ln.no, ind + 1);
    }
    const body = ln.text.slice(indent);
    if (/^-(\s|$)/.test(body)) break; // dãy ở cùng mức → để người gọi xử lý
    const { key, rest } = splitKey(body, ln, indent);
    cur.idx += 1;
    if (Object.hasOwn(out, key)) throw new YamlSyntaxError(`khoá trùng '${key}' trong cùng một mapping`, ln.no, indent + 1);
    out[key] = parseInlineValue(L, cur, indent, rest, ln);
  }
  return out;
}

function parseSequence(L, cur, indent) {
  const out = [];
  for (;;) {
    const ln = nextContent(L, cur);
    if (!ln) break;
    const ind = leadingSpaces(ln.text);
    if (ind < indent) break;
    if (ind > indent) {
      throw new YamlSyntaxError(`thụt lề lệch: dòng thụt ${ind} dấu cách trong dãy đang mở ở ${indent}`, ln.no, ind + 1);
    }
    const body = ln.text.slice(indent);
    if (!/^-(\s|$)/.test(body)) break;
    const after = body.slice(1);
    const trimmedAfter = after.trim();

    if (trimmedAfter === "" || trimmedAfter.startsWith("#")) {
      cur.idx += 1;
      const nxt = nextContent(L, cur);
      if (nxt && leadingSpaces(nxt.text) > indent) out.push(parseBlock(L, cur, leadingSpaces(nxt.text)));
      else out.push(null);
      continue;
    }
    const innerIndent = indent + 1 + leadingSpaces(after);
    /* Dạng gọn `- khoá: giá trị`: thay dấu '-' bằng khoảng trắng rồi đọc lại như khối thường,
     * nhờ vậy các dòng tiếp theo của cùng phần tử (thụt đúng innerIndent) ghép vào đúng chỗ. */
    if (isKeyLine(after.trimStart())) {
      L[cur.idx] = { no: ln.no, text: `${ln.text.slice(0, indent)} ${after}` };
      out.push(parseBlock(L, cur, innerIndent));
      continue;
    }
    cur.idx += 1;
    out.push(parseInlineValue(L, cur, innerIndent - 1, after, ln));
  }
  return out;
}

/* Có phải `khoá:` / `khoá: giá trị` không (để phân biệt với scalar trong dãy)? */
function isKeyLine(s) {
  if (s[0] === "'" || s[0] === '"') {
    try {
      const { end } = readQuoted(s, 0, { no: 0, text: s }, 0);
      return s[end] === ":";
    } catch { return false; }
  }
  if (s[0] === "{" || s[0] === "[") return false;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "#" && (i === 0 || s[i - 1] === " ")) return false;
    if (s[i] !== ":") continue;
    const n = s[i + 1];
    if (n === undefined || n === " ") return true;
  }
  return false;
}

function parseBlock(L, cur, indent) {
  const ln = nextContent(L, cur);
  if (!ln) return null;
  const ind = leadingSpaces(ln.text);
  if (ind !== indent) {
    throw new YamlSyntaxError(`thụt lề lệch: chờ ${indent} dấu cách, gặp ${ind}`, ln.no, ind + 1);
  }
  const body = ln.text.slice(indent);
  if (/^-(\s|$)/.test(body)) return parseSequence(L, cur, indent);
  return parseMapping(L, cur, indent);
}

/**
 * Đọc một tài liệu YAML thuộc tập con nêu ở đầu mục này.
 * @param {string} text Nội dung file.
 * @returns {unknown} Cây object/array/scalar tương ứng.
 * @throws {YamlSyntaxError} Khi gặp lỗi cú pháp HOẶC cấu trúc ngoài tập con.
 */
export function parseYamlSubset(text) {
  const src = text.replace(/^﻿/, "");
  const L = src.split(/\r?\n/).map((t, i) => ({ no: i + 1, text: t }));

  for (const ln of L) {
    const lead = /^[ \t]*/.exec(ln.text)[0];
    if (lead.includes("\t")) throw new YamlSyntaxError("tab ở phần thụt lề (YAML cấm tab để thụt lề)", ln.no, lead.indexOf("\t") + 1);
    if (/^(---|\.\.\.)\s*$/.test(ln.text)) throw new YamlSyntaxError("dấu phân tách nhiều document nằm ngoài tập con được hỗ trợ", ln.no, 1);
    if (/^\s*\?\s/.test(ln.text)) throw new YamlSyntaxError("khoá tường minh '? ' nằm ngoài tập con được hỗ trợ", ln.no, 1);
  }

  const cur = { idx: 0 };
  const first = nextContent(L, cur);
  if (!first) return null;
  const value = parseBlock(L, cur, leadingSpaces(first.text));
  const leftover = nextContent(L, cur);
  if (leftover) {
    throw new YamlSyntaxError(`dòng thừa sau khi tài liệu đã kết thúc: '${leftover.text.trim().slice(0, 60)}'`, leftover.no, 1);
  }
  return value;
}
