const fmtTime = (iso) =>
  new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });

export default function SavedList({ records, onBack }) {
  return (
    <>
      <main className="body">
        {records.length === 0 ? (
          <p className="empty">Chưa có nhãn nào được lưu.</p>
        ) : (
          <ul className="saved">
            {records.map((r) => (
              <li key={r.photoId || r.savedAt} className="saved-item">
                {r.thumb ? <img src={r.thumb} alt="" /> : <div className="nothumb">Không ảnh</div>}
                <div className="saved-body">
                  <div className="mono saved-pn">{r.partNumber}</div>
                  <div className="saved-name">{r.partName}</div>
                  <div className="saved-meta">
                    SL <b>{r.quantity}</b> · Vị trí <b className="mono">{r.location}</b>
                  </div>
                  <div className="saved-meta">
                    {fmtTime(r.savedAt)} · {r.capturedBy}
                  </div>
                  {r.photoId && <div className="saved-meta mono">{r.photoId}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      <div className="actionbar">
        <div className="buttons">
          <button className="btn confirm" onClick={onBack}>
            Nhập nhãn mới
          </button>
        </div>
      </div>
    </>
  );
}
