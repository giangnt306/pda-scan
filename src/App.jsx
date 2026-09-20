import { useMemo, useState } from "react";

/* ------------------------------------------------------------------
   Khai báo trường. Bước 3 sẽ ánh xạ JSON từ AI vào đúng `key` ở đây,
   nên thêm/bớt trường chỉ cần sửa mảng này.
------------------------------------------------------------------ */

const SUPPLIERS = [
  "Công ty TNHH Minh Phát",
  "Công ty CP Thực phẩm An Khang",
  "Vinatex Đà Nẵng",
  "Nhà cung cấp khác",
];

const ORIGINS = ["Việt Nam", "Trung Quốc", "Thái Lan", "Hàn Quốc", "Nhật Bản", "Khác"];

const REQUIRED_FIELDS = [
  { key: "lot", label: "Mã lô", mono: true, placeholder: "LOT-000000" },
  { key: "sku", label: "SKU / Mã hàng", mono: true, placeholder: "Quét mã vạch hoặc nhập tay" },
  { key: "supplier", label: "Nhà cung cấp", type: "select", options: SUPPLIERS },
  { key: "origin", label: "Nước sản xuất", type: "select", options: ORIGINS },
  { key: "qty", label: "Số lượng", type: "number", half: true, placeholder: "0" },
  {
    key: "uom",
    label: "Đơn vị",
    type: "select",
    half: true,
    options: ["Thùng", "Kiện", "Pallet", "Bao", "Cái", "Kg"],
  },
  { key: "location", label: "Vị trí lưu kho", mono: true, placeholder: "A-03-02" },
  { key: "receivedAt", label: "Ngày nhập", type: "date" },
];

const OPTIONAL_FIELDS = [
  { key: "mfgDate", label: "Ngày sản xuất", type: "date", half: true },
  { key: "expDate", label: "Hạn sử dụng", type: "date", half: true },
  { key: "po", label: "Số đơn hàng (PO)", mono: true, placeholder: "PO-000000" },
  { key: "vehicle", label: "Số container / biển số", mono: true, placeholder: "51C-123.45" },
  {
    key: "packaging",
    label: "Tình trạng bao bì",
    type: "select",
    options: ["Nguyên vẹn", "Móp nhẹ", "Rách hoặc ướt", "Khác"],
  },
  { key: "note", label: "Ghi chú", type: "textarea", placeholder: "Ghi thêm nếu có bất thường" },
];

const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
const today = () => new Date().toISOString().slice(0, 10);

const emptyValues = () =>
  Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f.key === "receivedAt" ? today() : ""]));

/* Kết quả AI giả lập — bước 3 sẽ thay bằng response thật từ backend */
const FAKE_AI = {
  lot: { value: "LOT-240918-A7", confidence: 0.96 },
  sku: { value: "SKU-88213-04", confidence: 0.93 },
  supplier: { value: "Công ty TNHH Minh Phát", confidence: 0.88 },
  origin: { value: "Việt Nam", confidence: 0.97 },
  qty: { value: "48", confidence: 0.71 },
  uom: { value: "Thùng", confidence: 0.9 },
  mfgDate: { value: "2026-08-02", confidence: 0.84 },
  expDate: { value: "2027-08-02", confidence: 0.82 },
};

const SURE_THRESHOLD = 0.9;

/* ------------------------------------------------------------------ */

function Field({ field, value, meta, error, onChange }) {
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
          {!meta?.edited && meta?.src === "sure" && (
            <span className="chip sure">AI {Math.round(meta.confidence * 100)}%</span>
          )}
          {!meta?.edited && meta?.src === "doubt" && (
            <span className="chip doubt">Kiểm tra lại · {Math.round(meta.confidence * 100)}%</span>
          )}
        </label>

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

        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

/* Gộp các trường `half` liền nhau thành một hàng ngang */
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

  return (
    <div className="fields">
      {rows.map((row, i) =>
        row.length === 2 ? (
          <div className="row" key={i}>
            {row.map((f) => (
              <Field key={f.key} field={f} value={rest.values[f.key]} meta={rest.metas[f.key]} error={rest.errors[f.key]} onChange={rest.onChange} />
            ))}
          </div>
        ) : (
          <Field
            key={row[0].key}
            field={row[0]}
            value={rest.values[row[0].key]}
            meta={rest.metas[row[0].key]}
            error={rest.errors[row[0].key]}
            onChange={rest.onChange}
          />
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

  const errors = useMemo(() => {
    const e = {};
    for (const f of REQUIRED_FIELDS) {
      const v = (values[f.key] || "").trim();
      if (!v) e[f.key] = "Chưa có dữ liệu";
      else if (f.key === "qty" && !(Number(v) > 0)) e[f.key] = "Số lượng phải lớn hơn 0";
    }
    if (values.expDate && values.mfgDate && values.expDate < values.mfgDate)
      e.expDate = "Hạn sử dụng trước ngày sản xuất";
    return e;
  }, [values]);

  const missing = Object.keys(errors).length;
  const doubtful = Object.entries(metas).filter(([, m]) => m.src === "doubt" && !m.edited).length;

  function handleChange(key, val) {
    setValues((s) => ({ ...s, [key]: val }));
    setMetas((s) => (s[key] ? { ...s, [key]: { ...s[key], edited: true } } : s));
  }

  function simulateAI() {
    const nextValues = { ...values };
    const nextMetas = {};
    for (const [key, r] of Object.entries(FAKE_AI)) {
      nextValues[key] = r.value;
      nextMetas[key] = {
        src: r.confidence >= SURE_THRESHOLD ? "sure" : "doubt",
        confidence: r.confidence,
        edited: false,
      };
    }
    setValues(nextValues);
    setMetas(nextMetas);
    setShowOptional(true);
  }

  function pickPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto(URL.createObjectURL(file));
    e.target.value = "";
  }

  function reset() {
    setValues(emptyValues());
    setMetas({});
    setPhoto(null);
    setTouched(false);
    setShowOptional(false);
    window.scrollTo({ top: 0 });
  }

  function confirm() {
    setTouched(true);
    if (missing) return;
    // Bước 5 sẽ POST payload này lên backend
    console.log("Xác nhận:", { values, metas });
    setSaved((n) => n + 1);
    setToast(`Đã lưu lô ${values.lot}`);
    setTimeout(() => setToast(""), 2600);
    reset();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Nhập kho — quét nhãn</h1>
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
              <img src={photo} alt="Ảnh nhãn vừa chụp" />
            ) : (
              <p>Đặt nhãn nằm gọn trong khung, giữ máy cách 20–30cm</p>
            )}
          </div>
          <div className="capture-actions">
            <label className="btn-as-label" style={{ flex: 1, display: "flex" }}>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={pickPhoto}
                style={{ display: "none" }}
              />
              <span
                style={{
                  flex: 1,
                  minHeight: "var(--tap)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 600,
                  fontSize: 15,
                  background: "var(--primary)",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                {photo ? "Chụp lại" : "Chụp nhãn"}
              </span>
            </label>
            <button onClick={simulateAI} disabled={!photo}>
              Nhận dạng
            </button>
          </div>
        </section>

        <div className="legend">
          <span>
            <i style={{ background: "var(--src-manual)" }} /> Người nhập
          </span>
          <span>
            <i style={{ background: "var(--src-sure)" }} /> AI chắc chắn
          </span>
          <span>
            <i style={{ background: "var(--src-doubt)" }} /> Cần kiểm tra
          </span>
        </div>

        <section className="group">
          <header>
            <h2>Thông tin bắt buộc</h2>
            <span className="note">{REQUIRED_FIELDS.length - missing}/{REQUIRED_FIELDS.length} trường</span>
          </header>
          <FieldList
            fields={REQUIRED_FIELDS}
            values={values}
            metas={metas}
            errors={touched ? errors : {}}
            onChange={handleChange}
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
            />
          </section>
        ) : (
          <button className="toggle" onClick={() => setShowOptional(true)}>
            Thêm thông tin bổ sung ({OPTIONAL_FIELDS.length} trường)
          </button>
        )}
      </main>

      <div className="actionbar">
        <div className={`status${touched && missing ? " blocked" : ""}`}>
          {missing
            ? `Còn ${missing} trường bắt buộc chưa điền`
            : doubtful
            ? `Đủ dữ liệu · ${doubtful} trường nên kiểm tra lại`
            : "Đủ dữ liệu, sẵn sàng lưu"}
        </div>
        <div className="buttons">
          <button className="btn" onClick={reset}>
            Xoá
          </button>
          <button className="btn confirm" onClick={confirm} disabled={touched && missing > 0}>
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
    </div>
  );
}
