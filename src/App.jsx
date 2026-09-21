import { useMemo, useState } from "react";
import ScannerSheet from "./ScannerSheet.jsx";
import SavedList from "./SavedList.jsx";
import { normalizeDate, normalizeCode, PART_NUMBER_RE, SA_NUMBER_RE } from "./lib/normalize.js";
import { downscale, buildFilename, photoId, saveToDevice, shareFile } from "./lib/camera.js";

const fmtKB = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);

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
    placeholder: "A-03-02",
  },
];

const OPTIONAL_FIELDS = [
  { key: "batch", label: "Batch", mono: true, placeholder: "260917_79F" },
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

// ponytail: chưa có login nên cố định người chụp; thay bằng user đăng nhập khi có auth.
const CAPTURED_BY = "Nguyễn Văn An";

/* Do hệ thống sinh, không nằm trong `values` nên người dùng không sửa được. */
const SYSTEM_FIELDS = [
  { key: "photoId", label: "ID ảnh", mono: true, readOnly: true, placeholder: "Sinh khi chụp" },
  { key: "capturedBy", label: "Người chụp", readOnly: true },
];
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

// ponytail: localStorage ~5 MB, đủ vài trăm nhãn kèm ảnh nhỏ; chuyển sang backend ở bước 4.
const STORE_KEY = "pda-scan.records";
const loadRecords = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  } catch {
    return [];
  }
};

const toDataUrl = (blob) =>
  new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
const DATE_KEYS = new Set(["shipmentDate"]);

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
    readOnly: field.readOnly,
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
  const [records, setRecords] = useState(loadRecords);
  const [view, setView] = useState("form");
  const [toast, setToast] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [autoSave, setAutoSave] = useState(true);

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

  /* `shot` là ảnh gốc ImageCapture chưa nén. Lưu nguyên bản vào máy,
   * còn bản thu nhỏ dùng để hiển thị và gửi OCR. */
  async function handlePhoto(shot) {
    if (photo?.url) URL.revokeObjectURL(photo.url);

    const at = new Date();
    const filename = buildFilename(shot, at);
    if (autoSave) saveToDevice(shot.blob, filename);

    const small = await downscale(shot.blob);
    setPhoto({
      ...small,
      id: photoId(at),
      original: {
        blob: shot.blob,
        filename,
        width: shot.width,
        height: shot.height,
        bytes: shot.blob.size,
        ms: shot.ms,
      },
    });
    if (autoSave) {
      setToast(`Đã lưu ${filename}`);
      setTimeout(() => setToast(""), 2600);
    }
    recognize(small); // chụp xong là đọc luôn
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

  async function confirm() {
    setTouched(true);
    if (blocking || Object.keys(errors).length) return;
    const thumb = photo ? await toDataUrl((await downscale(photo.blob, 240, 0.7)).blob) : "";
    const record = { ...values, ...systemValues, thumb, savedAt: new Date().toISOString() };
    const next = [record, ...records];
    setRecords(next);
    let msg = `Đã lưu ${values.partNumber}`;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      msg = "Bộ nhớ máy đầy — nhãn chỉ còn đến khi tải lại trang";
    }
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
    reset();
    setView("list");
  }

  const filled = REQUIRED_FIELDS.length - blocking;
  const systemValues = { photoId: photo?.id || "", capturedBy: CAPTURED_BY };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>{view === "list" ? "Nhãn đã lưu" : "Nhập kho linh kiện"}</h1>
          <div className="sub">Kho Long Biên · Ca sáng</div>
        </div>
        <button className="counter" onClick={() => setView("list")}>
          <b>{records.length}</b>
          <span>đã lưu</span>
        </button>
      </header>

      {view === "list" ? (
        <SavedList records={records} onBack={() => setView("form")} />
      ) : (
          <>
          <main className="body">
            <section className="capture">
              <div className="viewfinder">
                <div className="corners" aria-hidden="true" />
                {photo ? (
                  <img src={photo.url} alt="Ảnh nhãn vừa chụp" />
                ) : (
                  <p>Mở camera để chụp nhãn</p>
                )}
                {reading && <div className="reading">Đang đọc nhãn…</div>}
              </div>
              <div className="capture-actions">
                <button className="primary" onClick={() => setCameraOpen(true)}>
                  {photo ? "Chụp lại" : "Mở camera"}
                </button>
              </div>
            </section>

            <section className="testbench">
              <label className="check">
                <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
                Tự lưu ảnh gốc vào máy sau khi chụp
              </label>

              {photo?.original && (
                <dl className="shotinfo">
                  <div>
                    <dt>Ảnh gốc</dt>
                    <dd className="mono">
                      {photo.original.width}×{photo.original.height} · {fmtKB(photo.original.bytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>Thời gian chụp</dt>
                    <dd className="mono">{photo.original.ms} ms</dd>
                  </div>
                  <div>
                    <dt>Bản gửi OCR</dt>
                    <dd className="mono">
                      {photo.width}×{photo.height} · {fmtKB(photo.blob.size)}
                    </dd>
                  </div>
                  <div className="full">
                    <dt>Tên file</dt>
                    <dd className="mono small">{photo.original.filename}</dd>
                  </div>
                  <div className="actions">
                    <button className="btn small" onClick={() => saveToDevice(photo.original.blob, photo.original.filename)}>
                      Tải lại ảnh gốc
                    </button>
                    <button
                      className="btn small"
                      onClick={async () => {
                        const ok = await shareFile(photo.original.blob, photo.original.filename);
                        if (!ok) {
                          setToast("Máy không hỗ trợ chia sẻ file — dùng Tải lại ảnh gốc");
                          setTimeout(() => setToast(""), 2600);
                        }
                      }}
                    >
                      Lưu vào Thư viện ảnh
                    </button>
                  </div>
                </dl>
              )}
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
                <h2>Thông tin ảnh</h2>
                <span className="note">tự động</span>
              </header>
              <FieldList fields={SYSTEM_FIELDS} values={systemValues} metas={{}} errors={{}} onChange={() => {}} />
            </section>

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
          </>
      )}

      {toast && (
        <div className="toast" role="status">
          <span className="dot" />
          {toast}
        </div>
      )}

      {cameraOpen && (
        <ScannerSheet onPhoto={handlePhoto} onClose={() => setCameraOpen(false)} />
      )}
    </div>
  );
}
