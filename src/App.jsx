import { useMemo, useState } from "react";
import ScannerSheet from "./ScannerSheet.jsx";
import { normalizeDate, normalizeCode, PART_NUMBER_RE, SA_NUMBER_RE } from "./lib/normalize.js";

/* ------------------------------------------------------------------
   Schema rút từ nhãn thật trong kho (xem thư mục samples/).
   Bước 4 sẽ ánh xạ JSON của VLM vào đúng `key` ở đây.
------------------------------------------------------------------ */

const SUPPLIERS = [
  "Nội bộ — Made in Vietnam",
  "Jiangsu Tiemao Technology",
  "Nhà cung cấp khác",
];

const REQUIRED_FIELDS = [
  {
    key: "partNumber",
    label: "Part Number",
    mono: true,
    scannable: true,
    placeholder: "BEX75149000AB",
    validate: (v) =>
      PART_NUMBER_RE.test(v) ? "" : "Sai định dạng — cần 3 chữ + 8 số + 2–6 chữ",
  },
  { key: "partName", label: "Tên linh kiện", placeholder: "WINDSCREEN_L2" },
  { key: "quantity", label: "Số lượng", type: "number", half: true, placeholder: "0" },
  { key: "shipmentDate", label: "Ngày xuất hàng", type: "date", half: true },
  { key: "supplier", label: "Nhà cung cấp", type: "select", options: SUPPLIERS },
  {
    key: "location",
    label: "Vị trí lưu kho",
    mono: true,
    scannable: true,
    placeholder: "A-03-02",
  },
];

const OPTIONAL_FIELDS = [
  { key: "batch", label: "Batch", mono: true, scannable: true, placeholder: "260917_79F" },
  {
    key: "saNumber",
    label: "SA Number",
    mono: true,
    placeholder: "5300013959",
    validate: (v) => (SA_NUMBER_RE.test(v) ? "" : "SA Number phải đủ 10 chữ số"),
  },
  { key: "variant", label: "Phiên bản / Màu", half: true, placeholder: "VF8 NP" },
  { key: "plantDock", label: "Plant / Dock", mono: true, half: true, placeholder: "3001/1001" },
  { key: "grossWeight", label: "Gross weight (kg)", type: "number", half: true },
  {
    key: "packaging",
    label: "Tình trạng bao bì",
    type: "select",
    half: true,
    options: ["Nguyên vẹn", "Móp nhẹ", "Rách hoặc ướt", "Khác"],
  },
  { key: "note", label: "Ghi chú", type: "textarea", placeholder: "Ghi thêm nếu có bất thường" },
];

const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
const emptyValues = () => Object.fromEntries(ALL_FIELDS.map((f) => [f.key, ""]));

/* Kết quả giả lập, mô phỏng đúng nhãn BATTERY_PACK_REAR_FENDER.
 * Bước 4 thay bằng response thật; cấu trúc giữ nguyên. */
const FAKE_AI = {
  partNumber: { value: "BEX32181030AB", confidence: 0.94 },
  partName: { value: "BATTERY_PACK_REAR_FENDER", confidence: 0.96 },
  quantity: { value: "80", confidence: 0.91 },
  shipmentDate: { value: "15/9/2026", confidence: 0.62 }, // viết tay → độ tin thấp
  saNumber: { value: "5300013009", confidence: 0.89 },
  variant: { value: "Limo Green", confidence: 0.93 },
  supplier: { value: "Nội bộ — Made in Vietnam", confidence: 0.75 },
};

const SURE_THRESHOLD = 0.9;
const DATE_KEYS = new Set(["shipmentDate"]);

/* ------------------------------------------------------------------ */

function Field({ field, value, meta, error, onChange, onScan }) {
  const src = meta?.edited ? "manual" : meta?.src || "manual";
  const id = `f-${field.key}`;
  const required = REQUIRED_FIELDS.some((f) => f.key === field.key);

  const common = {
    id,
    value,
    onChange: (e) => onChange(field.key, e.target.value),
    className: field.mono ? "mono" : undefined,
    placeholder: field.placeholder,
  };

  return (
    <div className="field" data-src={src} data-invalid={Boolean(error)}>
      <div className="src" aria-hidden="true" />
      <div className="inner">
        <label htmlFor={id}>
          {field.label}
          {required && (
            <span className="req" aria-label="bắt buộc">
              *
            </span>
          )}
          {meta?.edited && <span className="chip edited">đã sửa</span>}
          {!meta?.edited && meta?.via === "scan" && <span className="chip sure">đã quét</span>}
          {!meta?.edited && meta?.via === "ai" && meta.src === "sure" && (
            <span className="chip sure">AI {Math.round(meta.confidence * 100)}%</span>
          )}
          {!meta?.edited && meta?.via === "ai" && meta.src === "doubt" && (
            <span className="chip doubt">Kiểm tra lại · {Math.round(meta.confidence * 100)}%</span>
          )}
        </label>

        <div className="control">
          {field.type === "select" ? (
            <select {...common}>
              <option value="">— Chọn —</option>
              {field.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : field.type === "textarea" ? (
            <textarea {...common} rows={2} />
          ) : (
            <input
              {...common}
              type={field.type || "text"}
              inputMode={field.type === "number" ? "numeric" : undefined}
            />
          )}

          {field.scannable && (
            <button
              type="button"
              className="scanbtn"
              onClick={() => onScan(field)}
              aria-label={`Quét ${field.label}`}
              title={`Quét ${field.label}`}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path
                  d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path d="M7 12h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

function FieldList({ fields, ...rest }) {
  const rows = [];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].half && fields[i + 1]?.half) {
      rows.push([fields[i], fields[i + 1]]);
      i++;
    } else {
      rows.push([fields[i]]);
    }
  }

  const render = (f) => (
    <Field
      key={f.key}
      field={f}
      value={rest.values[f.key]}
      meta={rest.metas[f.key]}
      error={rest.errors[f.key]}
      onChange={rest.onChange}
      onScan={rest.onScan}
    />
  );

  return (
    <div className="fields">
      {rows.map((row, i) =>
        row.length === 2 ? (
          <div className="row" key={i}>
            {row.map(render)}
          </div>
        ) : (
          render(row[0])
        )
      )}
    </div>
  );
}

export default function App() {
  const [values, setValues] = useState(emptyValues);
  const [metas, setMetas] = useState({});
  const [photo, setPhoto] = useState(null);
  const [showOptional, setShowOptional] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(0);
  const [toast, setToast] = useState("");
  const [scanner, setScanner] = useState(null);
  const [reading, setReading] = useState(false);

  const errors = useMemo(() => {
    const e = {};
    for (const f of REQUIRED_FIELDS) {
      const v = (values[f.key] || "").trim();
      if (!v) e[f.key] = "Chưa có dữ liệu";
      else if (f.key === "quantity" && !(Number(v) > 0)) e[f.key] = "Số lượng phải lớn hơn 0";
      else if (f.validate) {
        const msg = f.validate(v);
        if (msg) e[f.key] = msg;
      }
    }
    // Trường tuỳ chọn: chỉ bắt lỗi khi người dùng có nhập
    for (const f of OPTIONAL_FIELDS) {
      const v = (values[f.key] || "").trim();
      if (v && f.validate) {
        const msg = f.validate(v);
        if (msg) e[f.key] = msg;
      }
    }
    return e;
  }, [values]);

  const blocking = REQUIRED_FIELDS.filter((f) => errors[f.key]).length;
  const doubtful = Object.entries(metas).filter(([, m]) => m.src === "doubt" && !m.edited).length;

  function handleChange(key, val) {
    setValues((s) => ({ ...s, [key]: val }));
    setMetas((s) => (s[key] ? { ...s, [key]: { ...s[key], edited: true } } : s));
  }

  function handleBarcode(key, value) {
    const target = key || "partNumber";
    setValues((s) => ({ ...s, [target]: normalizeCode(value) }));
    setMetas((s) => ({ ...s, [target]: { src: "sure", via: "scan", confidence: 1, edited: false } }));
    setToast(`Đã quét ${value}`);
    setTimeout(() => setToast(""), 1800);
    setScanner(null);
  }

  /* Bước 4 thay thân hàm này bằng POST ảnh lên backend.
   * Phần xử lý kết quả bên dưới giữ nguyên. */
  async function recognize(frame) {
    setReading(true);
    await new Promise((r) => setTimeout(r, 900)); // giả lập độ trễ mạng
    applyAiResult(FAKE_AI);
    setReading(false);
  }

  function applyAiResult(result) {
    const nextValues = { ...values };
    const nextMetas = { ...metas };

    for (const [key, r] of Object.entries(result)) {
      if (nextMetas[key]?.via === "scan") continue; // barcode luôn thắng OCR

      let v = r.value;
      if (DATE_KEYS.has(key)) v = normalizeDate(v);
      else if (key === "partNumber" || key === "saNumber") v = normalizeCode(v);

      nextValues[key] = v;
      nextMetas[key] = {
        // Chuẩn hoá thất bại thì hạ độ tin xuống, buộc người kiểm tra nhìn lại
        src: v && r.confidence >= SURE_THRESHOLD ? "sure" : "doubt",
        via: "ai",
        confidence: v ? r.confidence : 0,
        edited: false,
      };
    }

    setValues(nextValues);
    setMetas(nextMetas);
    setShowOptional(true);
  }

  function handlePhoto(frame) {
    if (photo?.url) URL.revokeObjectURL(photo.url);
    setPhoto(frame);
    recognize(frame); // chụp xong là đọc luôn, không bắt bấm thêm nút
  }

  function reset() {
    if (photo?.url) URL.revokeObjectURL(photo.url);
    setValues(emptyValues());
    setMetas({});
    setPhoto(null);
    setTouched(false);
    setShowOptional(false);
    window.scrollTo({ top: 0 });
  }

  function confirm() {
    setTouched(true);
    if (blocking || Object.keys(errors).length) return;
    console.log("Xác nhận:", { values, metas, photo: photo?.blob });
    setSaved((n) => n + 1);
    setToast(`Đã lưu ${values.partNumber}`);
    setTimeout(() => setToast(""), 2600);
    reset();
  }

  const filled = REQUIRED_FIELDS.length - blocking;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Nhập kho linh kiện</h1>
          <div className="sub">Kho Long Biên · Ca sáng</div>
        </div>
        <div className="counter">
          <b>{saved}</b>
          <span>đã lưu</span>
        </div>
      </header>

      <main className="body">
        <section className="capture">
          <div className="viewfinder">
            <div className="corners" aria-hidden="true" />
            {photo ? (
              <img src={photo.url} alt="Ảnh nhãn vừa chụp" />
            ) : (
              <p>Mở camera để quét mã vạch hoặc chụp lại nhãn</p>
            )}
            {reading && <div className="reading">Đang đọc nhãn…</div>}
          </div>
          <div className="capture-actions">
            <button className="primary" onClick={() => setScanner({ target: null })}>
              {photo ? "Chụp lại" : "Mở camera"}
            </button>
          </div>
        </section>

        <div className="legend">
          <span>
            <i style={{ background: "var(--src-manual)" }} /> Người nhập
          </span>
          <span>
            <i style={{ background: "var(--src-sure)" }} /> Máy đọc chắc chắn
          </span>
          <span>
            <i style={{ background: "var(--src-doubt)" }} /> Cần kiểm tra
          </span>
        </div>

        <section className="group">
          <header>
            <h2>Thông tin bắt buộc</h2>
            <span className="note">
              {filled}/{REQUIRED_FIELDS.length} trường
            </span>
          </header>
          <FieldList
            fields={REQUIRED_FIELDS}
            values={values}
            metas={metas}
            errors={touched ? errors : {}}
            onChange={handleChange}
            onScan={(field) => setScanner({ target: field })}
          />
        </section>

        {showOptional ? (
          <section className="group">
            <header>
              <h2>Thông tin bổ sung</h2>
              <span className="note">không bắt buộc</span>
            </header>
            <FieldList
              fields={OPTIONAL_FIELDS}
              values={values}
              metas={metas}
              errors={touched ? errors : {}}
              onChange={handleChange}
              onScan={(field) => setScanner({ target: field })}
            />
          </section>
        ) : (
          <button className="toggle" onClick={() => setShowOptional(true)}>
            Thêm thông tin bổ sung ({OPTIONAL_FIELDS.length} trường)
          </button>
        )}
      </main>

      <div className="actionbar">
        <div className={`status${touched && blocking ? " blocked" : ""}`}>
          {blocking
            ? `Còn ${blocking} trường bắt buộc chưa đạt`
            : doubtful
            ? `Đủ dữ liệu · ${doubtful} trường nên kiểm tra lại`
            : "Đủ dữ liệu, sẵn sàng lưu"}
        </div>
        <div className="buttons">
          <button className="btn" onClick={reset}>
            Xoá
          </button>
          <button className="btn confirm" onClick={confirm} disabled={touched && blocking > 0}>
            Xác nhận và lưu
          </button>
        </div>
      </div>

      {toast && (
        <div className="toast" role="status">
          <span className="dot" />
          {toast}
        </div>
      )}

      {scanner && (
        <ScannerSheet
          target={scanner.target}
          onBarcode={handleBarcode}
          onPhoto={handlePhoto}
          onClose={() => setScanner(null)}
        />
      )}
    </div>
  );
}
