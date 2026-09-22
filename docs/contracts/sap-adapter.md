# Hợp đồng SAP adapter — `postGoodsReceipt`

> **`[ĐÃ HIỆN THỰC — PHASE 4]`** · Interface + 2 lớp lỗi ở `apps/server/src/sap/adapter.js`;
> mock 4 mode ở `apps/server/src/sap/mock.js`. Cả hai file **đang chạy thật**. `SAP_ADAPTER=http`
> để nối **SAP thật** vẫn là việc của **Phase 7** và phụ thuộc 10 câu hỏi chưa ai trả lời ở §8 —
> `SAP_ADAPTERS` hiện chỉ nhận `mock | none` (`config.js:35`).
>
> **Mức độ hiện thực.** Đo lúc **2026-09-22 02:48 +07**: `sap/adapter.js` 55 dòng, `sap/mock.js`
> 94 dòng. **Mốc thời gian này sẽ cũ đi** — chạy lại hai lệnh dưới đây trước khi tin con số, và
> sửa dòng này nếu kết quả khác:
>
> ```bash
> wc -l apps/server/src/sap/adapter.js apps/server/src/sap/mock.js
> grep -n "SAP_ADAPTER\|SAP_TIMEOUT_MS\|OUTBOX_" apps/server/src/config.js
> ```
>
> Mọi mục dưới đây mô tả **code đang chạy**, trừ những chỗ ghi rõ `PHASE 7`.

**Tham chiếu:** [../architecture-v2.md §4.5](../architecture-v2.md) ·
[../communication-layers.md §4](../communication-layers.md) ·
[../receipt-lifecycle.md](../receipt-lifecycle.md) · [../data-model.md](../data-model.md) ·
[../specs/phase-4/02-lifecycle-and-outbox.md §7](../specs/phase-4/02-lifecycle-and-outbox.md)

---

## 1. Interface

```js
/**
 * @typedef {Object} GoodsReceiptPayload
 * @property {string}      receiptId    UUID do BE sinh. ĐÂY LÀ KHOÁ IDEMPOTENCY phía SAP.
 * @property {string}      createdAt    ISO-8601 UTC, ms + 'Z'. Thời điểm phiếu được xác nhận.
 * @property {string|null} deviceId     Thiết bị đã tạo phiếu.
 * @property {string|null} sessionId    Phiên làm việc.
 * @property {string|null} warehouse    Lấy từ sessions.warehouse.
 * @property {string|null} operator     Lấy từ sessions.operator.
 * @property {ReceiptData} data         ĐÚNG 13 key, kiểu như docs/api.md và components.schemas.ReceiptData.
 */

/**
 * @typedef {Object} GoodsReceiptResult
 * @property {string} sapDocumentNo   Số chứng từ SAP. Gửi lại cùng receiptId PHẢI trả cùng giá trị.
 * @property {string} postedAt        ISO-8601 UTC do SAP trả (không phải giờ của BE).
 */

/**
 * @param {GoodsReceiptPayload} payload
 * @param {{ signal: AbortSignal }} options   signal = AbortSignal.timeout(SAP_TIMEOUT_MS)
 * @returns {Promise<GoodsReceiptResult>}
 * @throws {SapBusinessError}  → phiếu chuyển 'rejected', KHÔNG retry
 * @throws {SapTechnicalError} → phiếu ở lại 'posting', retry theo backoff
 */
export async function postGoodsReceipt(payload, { signal }) { /* Phase 4 */ }

/**
 * Huỷ một chứng từ đã posted. Dùng chung bảng mode với postGoodsReceipt.
 * @param {{ receiptId: string, sapDocumentNo: string }} p
 * @param {{ signal: AbortSignal }} options
 * @returns {Promise<{ reversalDocumentNo: string, postedAt: string }>}
 */
export async function reverseGoodsReceipt(p, { signal }) { /* Phase 4 */ }

/** Chọn adapter theo config.sap.adapter. "none" → trả null (worker KHÔNG khởi động). */
export function selectSapAdapter({ config, sim, logger }) { /* Phase 4 */ }
```

Hình dạng adapter mà worker trông đợi — **đúng 3 key**:

```js
/**
 * @typedef {Object} SapAdapter
 * @property {string} name                 "mock" (Phase 4) | "http" (Phase 7)
 * @property {Function} postGoodsReceipt
 * @property {Function} reverseGoodsReceipt
 */
```

Hai lớp lỗi, **bắt buộc phân biệt** — đây là toàn bộ lý do file này tồn tại:

```js
export class SapBusinessError extends Error {
  /** @param {string} code  SAP_PART_UNKNOWN | SAP_LOCATION_LOCKED | SAP_QTY_EXCEEDS_PO | SAP_DUPLICATE_DOCUMENT */
  constructor(code, message, { sapMessage } = {}) {
    super(message);
    this.code = code;
    this.sapMessage = sapMessage ?? null;  // nguyên văn SAP trả, để tra cứu; KHÔNG hiển thị cho người vận hành
  }
}

export class SapTechnicalError extends Error {
  /** @param {string} code  SAP_UNAVAILABLE | SAP_TIMEOUT | SAP_AUTH_FAILED */
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;       // HTTP status nếu có
    this.retryable = true;      // luôn true; tồn tại để đọc code không phải tra bảng
  }
}
```

> **Quy tắc vàng.** Adapter **không được** ném `Error` trần. Mọi lỗi phải là một trong hai lớp trên.
> Một lỗi không phân loại được là **lỗi kỹ thuật** (`SAP_UNAVAILABLE`) — thà retry vô ích còn hơn
> đánh dấu `rejected` oan một phiếu hợp lệ rồi bắt người vận hành nhập lại.

---

## 2. Payload gửi đi

```json
{
  "receiptId": "c2e51dbb-1b93-4f2e-8d2a-5a1a3f4e9c77",
  "createdAt": "2026-09-21T14:10:00.321Z",
  "deviceId": "0d5c7f33-9d59-4d2e-8f11-0b3c9c0bd511",
  "sessionId": "6a1f0f0d-3cc4-4b26-9a2e-1e8be2b1c7a4",
  "warehouse": "Kho Long Biên",
  "operator": "NV-0142 Trần Văn Bình",
  "data": {
    "partNumber": "BEX32181030AB",
    "partName": "BATTERY_PACK_REAR_FENDER",
    "quantity": 80,
    "shipmentDate": "2026-09-15",
    "supplier": "Nội bộ — Made in Vietnam",
    "location": "A-03-02",
    "batch": null,
    "saNumber": null,
    "variant": null,
    "plantDock": null,
    "grossWeight": 12.5,
    "packaging": null,
    "note": null
  }
}
```

**Header khuyến nghị** (chốt chính xác sau khi SAP team trả lời câu 1–2 ở §8):

```http
POST <SAP_ENDPOINT> HTTP/1.1
content-type: application/json
authorization: <theo SAP team>
idempotency-key: c2e51dbb-1b93-4f2e-8d2a-5a1a3f4e9c77    ← chính là receiptId
x-request-id: <sinh mới mỗi attempt, để truy vết>
```

**Trạng thái trả về**

```json
{ "sapDocumentNo": "5000123456", "postedAt": "2026-09-21T14:10:21.004Z" }
```

Adapter **không** lưu gì, **không** đổi trạng thái phiếu, **không** ghi `receipt_events`. Nó chỉ gọi
và phân loại lỗi. Việc chuyển trạng thái là của outbox worker — tách bạch để adapter test được
độc lập với DB.

---

## 3. Bảng mã lỗi **nghiệp vụ** (`SapBusinessError` — KHÔNG retry)

| code | Nghĩa | Phiếu chuyển sang | Hành động khuyến nghị cho người vận hành |
|---|---|---|---|
| `SAP_PART_UNKNOWN` | `partNumber` không có trong master data của SAP | `rejected` | Kiểm tra lại mã trên nhãn (AI hay thêm/bớt một chữ số). Sửa → tạo phiếu `corrected`. Nếu mã đúng thật → báo bộ phận master data, phiếu nằm chờ |
| `SAP_LOCATION_LOCKED` | Vị trí kho đang bị khoá (kiểm kê, phong toả) | `rejected` | Chọn vị trí khác rồi "Sửa"; hoặc đợi mở khoá rồi "Gửi lại" — **nhưng** `rejected` không có đường về `posting`, nên vẫn phải đi qua `corrected` |
| `SAP_QTY_EXCEEDS_PO` | Số lượng vượt đơn hàng / ASN | `rejected` | Đếm lại pallet. Nếu số đúng → cần quản lý ca duyệt vượt, ngoài phạm vi app |
| `SAP_DUPLICATE_DOCUMENT` | `receiptId` này đã có chứng từ **khác** trong SAP | `rejected` | Hiếm; nghĩa là idempotency hai bên hiểu khác nhau. Ghi log `error`, báo IT. **Không** tự sinh `receiptId` mới |

Hiển thị cho người vận hành: dùng `message` tiếng Việt do adapter đặt, **không** dùng `sapMessage`
(thường là tiếng Anh/Đức viết tắt, vô nghĩa với người đứng cạnh pallet). `sapMessage` đi vào log và vào
`receipt_events.detail` để IT tra cứu.

## 4. Bảng mã lỗi **kỹ thuật** (`SapTechnicalError` — CÓ retry)

| code | Nghĩa | Nhận biết | Ghi chú |
|---|---|---|---|
| `SAP_UNAVAILABLE` | SAP không phục vụ được | HTTP 500/502/503/504, `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, JSON hỏng, **và mọi lỗi không phân loại được** | Trường hợp phổ biến nhất |
| `SAP_TIMEOUT` | Quá `SAP_TIMEOUT_MS` (mặc định 15 000 ms) | `AbortError` / `TimeoutError` từ `signal` | **Nguy hiểm nhất**: không biết SAP đã ghi hay chưa. Retry an toàn **chỉ vì** `receiptId` là khoá idempotency |
| `SAP_AUTH_FAILED` | HTTP 401/403 | — | Retry thường vô ích, nhưng vẫn xếp vào kỹ thuật: token có thể tự làm mới. Sau 5 lượt → `post_failed` và cần người sửa cấu hình |

---

## 5. Chính sách retry

Mọi giá trị dưới đây **có biến môi trường tương ứng** (hợp đồng Phase 4 §11); đừng hard-code chúng
trong code, và đừng viết "khoảng 1 giây" trong tài liệu.

| Tham số | Env | Mặc định | Ràng buộc |
|---|---|---|---|
| Adapter đang dùng | `SAP_ADAPTER` | `mock` | `mock` \| `none`. `none` = **tắt hoàn toàn** outbox + worker |
| Timeout mỗi lần gọi | `SAP_TIMEOUT_MS` | **15 000 ms** | integer ≥ 1000 |
| Số lần gọi tối đa | `SAP_MAX_ATTEMPTS` | **5** (tính cả lần đầu) | integer 1..10 |
| Backoff trước attempt 2, 3, 4, 5 | `OUTBOX_BACKOFF_MS` | **`5000,15000,60000,60000`** | chuỗi CSV số nguyên |
| Chu kỳ worker quét bảng `outbox` | `OUTBOX_TICK_MS` | **1 000 ms** | integer 20..60000 |
| Bật/tắt worker | `OUTBOX_ENABLED` | `true` | `false` = job vẫn được tạo nhưng không ai xử lý (để test tay) |
| Độ trễ mock mode `success` | `SAP_MOCK_SUCCESS_DELAY_MS` | **300 ms** | integer ≥ 0 |
| Độ trễ mock mode `slow` | `SAP_MOCK_SLOW_DELAY_MS` | **8 000 ms** | integer ≥ 0 |

| | |
|---|---|
| Tổng thời gian tệ nhất | `5 × 15 000 + (5 000 + 15 000 + 60 000 + 60 000)` = **215 000 ms** (≈ 3 phút 35 giây) |
| Hết lượt | `receipts.status = 'post_failed'`, `outbox.state = 'failed'`, ghi `receipt.post_failed` |
| Gửi lại thủ công | `POST /api/receipts/{receiptId}/retry-post` → `attempts = 0`, `next_attempt_at = now`, phiếu về `posting`. Trả **202**, không phải 200 |
| Jitter | **Không.** Một kho có vài chục PDA, không phải vài nghìn; jitter chỉ làm test khó tất định |

Worker poll bảng `outbox` mỗi **1 000 ms** (`OUTBOX_TICK_MS`, giá trị chính xác — không phải
"khoảng 1 giây"), chọn `state='pending' AND next_attempt_at <= now`, tối đa **10** job mỗi tick, xử
lý **tuần tự** (`await` xong job này mới sang job kế). SQLite chỉ có một writer; chạy song song chỉ
tạo `SQLITE_BUSY`. Với mock `success` 300 ms, 10 job mất 3 s — chấp nhận được.

Timer của worker **bắt buộc** `unref()`: không có nó thì `node --test` treo vô hạn sau khi test
xong. Và `close()` của app **bắt buộc** `worker.stop()` **trước** `db.close()`, nếu không tick kế
tiếp sẽ `prepare()` trên một DB đã đóng và ném `ERR_SQLITE` ra ngoài mọi `try/catch`.

**Backoff tính bằng `attempts` SAU khi đã `+1`** — `attempts` tăng **trước** khi gọi SAP, nên lần
gọi đầu tiên là `attempts = 1`:

| `attempts` sau lần thử | Kết quả nếu lỗi kỹ thuật | Chờ bao lâu trước lần sau |
|---|---|---|
| 1 | retry | `backoffsMs[0]` = **5 000 ms** |
| 2 | retry | `backoffsMs[1]` = **15 000 ms** |
| 3 | retry | `backoffsMs[2]` = **60 000 ms** |
| 4 | retry | `backoffsMs[3]` = **60 000 ms** |
| 5 | **`post_failed`** | — |

**Lỗi không phân loại được = lỗi kỹ thuật.** Nếu adapter ném một `Error` trần (bug trong adapter,
hoặc `TypeError`), worker coi nó là `SapTechnicalError("SAP_UNAVAILABLE")`: thà retry vô ích còn hơn
đánh dấu `rejected` oan một phiếu hợp lệ rồi bắt người vận hành nhập lại.

---

## 6. Idempotency

`receiptId` là khoá ngoài (external key / `Idempotency-Key`) phía SAP. Yêu cầu bắt buộc:

> **Gửi lại cùng một `receiptId` phải trả về cùng một `sapDocumentNo`, và không tạo chứng từ thứ hai.**

Không có tính chất này thì toàn bộ chính sách retry ở §5 là không an toàn: mỗi lần `SAP_TIMEOUT` sẽ có
nguy cơ sinh một chứng từ trùng trong ERP. Nếu SAP team trả lời **không** hỗ trợ (câu 1 ở §8), phải đổi
thiết kế: trước mỗi retry phải **truy vấn** xem chứng từ đã tồn tại chưa (`GET` theo `receiptId`), và
điều đó cần thêm một endpoint nữa từ phía SAP.

Ba tình huống phải đúng:

| Tình huống | Kỳ vọng |
|---|---|
| Gửi lần 1 timeout, lần 2 thành công, nhưng SAP **đã ghi** ở lần 1 | Lần 2 trả **cùng** `sapDocumentNo` của lần 1. Đúng 1 chứng từ |
| BE chết sau khi SAP trả 200 nhưng trước khi `UPDATE receipts` | Phiếu còn `posting` → worker gửi lại → cùng `sapDocumentNo` → `posted`. Đúng 1 chứng từ |
| Người vận hành bấm "Gửi lại" trên phiếu `post_failed` mà SAP thực ra đã ghi | Trả cùng `sapDocumentNo` → phiếu về `posted`. Đúng 1 chứng từ |

---

## 7. Mock SAP — 4 mode

Mock nằm sau **cùng một interface**, chọn bằng `sim.sap.mode` (Phase 3 đã lưu và phản chiếu sẵn giá
trị này trong `status.sim.effective.sap`; **Phase 4 bắt đầu dùng nó thật**).

**Đọc mode ở đâu:** `sim.effective({ deviceId: null }).sap` — **phạm vi toàn cục**, đọc lại **ở mỗi
lần gọi** (không cache), để bật/tắt kịch bản có hiệu lực ngay với job kế tiếp.

> **SAP mock CHỈ nghe kịch bản TOÀN CỤC.** Kịch bản đặt qua
> `PUT /api/admin/sim/devices/{deviceId}` **không** ảnh hưởng SAP. Lý do: SAP là hệ thống ở đầu kia
> của Main Backend, nó không biết phiếu đến từ PDA nào. Kịch bản theo thiết bị chỉ có nghĩa cho
> `backend` / `ocr` / `save` — những thứ nằm trên đường đi của **request** từ thiết bị đó.
> Màn hình S8 phải ghi rõ điều này và **khoá** dòng SAP khi người dùng chọn phạm vi "máy này".

`sim.sap.latencyMs` **cộng dồn** vào độ trễ của mock ở **mọi** mode. Mode `down` ném ngay, không chờ,
nên `latencyMs` không áp cho nó.

| mode | Hành vi của `postGoodsReceipt` | Ném |
|---|---|---|
| `success` | Chờ `SAP_MOCK_SUCCESS_DELAY_MS + latencyMs` (mặc định **300 ms** + 0). Nếu `receiptId` đã có trong map `issued` → trả **cùng** `sapDocumentNo` cũ. Ngược lại `seq++`, `no = "5000" + String(seq).padStart(6,"0")`, lưu vào `issued`, trả `{ sapDocumentNo: no, postedAt: now }` | — |
| `slow` | Chờ `SAP_MOCK_SLOW_DELAY_MS + latencyMs` (mặc định **8 000 ms**) rồi xử lý **y hệt** `success` | — (nhưng nếu `SAP_TIMEOUT_MS` < 8 000 thì `signal` bắn trước → `SapTechnicalError("SAP_TIMEOUT")`. **Đó chính là điểm demo**) |
| `reject` | Chờ `300 + latencyMs` ms rồi ném lỗi **nghiệp vụ** | `SapBusinessError("SAP_PART_UNKNOWN", "SAP từ chối: mã linh kiện không tồn tại", { sapMessage: "Material <partNumber> does not exist in plant 1000" })` |
| `down` | Ném **ngay**, không chờ — mô phỏng `ECONNREFUSED` | `SapTechnicalError("SAP_UNAVAILABLE", "Không kết nối được SAP", { status: null })` |

`reverseGoodsReceipt` dùng **cùng bảng mode**:

| mode | Hành vi |
|---|---|
| `success` \| `slow` | chờ tương ứng, trả `{ reversalDocumentNo: "5900" + String(seq).padStart(6,"0"), postedAt }` |
| `reject` | ném `SapBusinessError("SAP_DUPLICATE_DOCUMENT", "SAP từ chối huỷ chứng từ")` |
| `down` | ném `SapTechnicalError("SAP_UNAVAILABLE", …)` |

Hàm `sleep` của mock **phải tôn trọng `signal`** — `clearTimeout` rồi `reject` bằng
`SapTechnicalError("SAP_TIMEOUT", "SAP phản hồi quá lâu")` khi `abort` bắn. Không làm thế thì mode
`slow` sẽ giữ tiến trình quá `SAP_TIMEOUT_MS` và kịch bản timeout không bao giờ quan sát được.

Mock **phải** giữ map `receiptId → sapDocumentNo` trong bộ nhớ, để mode `success` cũng chứng minh
được tính idempotent ở §6 — nếu không, test idempotency sẽ **xanh giả**.

---

## 8. Câu hỏi cần SAP team trả lời

Không trả lời được những câu này thì Phase 4 chỉ dựng được mock, không nối được thật.

| # | Câu hỏi | Vì sao cần | Mặc định nếu không có trả lời |
|---|---|---|---|
| 1 | **Endpoint thật là gì** (URL, method), và có hỗ trợ **idempotency key** không? Nếu có thì qua header nào? | Toàn bộ §5–§6 phụ thuộc câu này | Giả định có, qua `idempotency-key: <receiptId>` |
| 2 | **Auth** kiểu gì: basic, OAuth2 client credentials, chứng chỉ client, hay API key? Token sống bao lâu, làm mới thế nào? | Quyết định `SAP_AUTH_FAILED` có đáng retry không | Bearer token tĩnh trong env |
| 3 | **Định dạng ngày** SAP nhận: `YYYY-MM-DD`, `YYYYMMDD`, hay `DD.MM.YYYY`? Có timezone không? | App đang chuẩn hoá về `YYYY-MM-DD` (UTC, không giờ) | Gửi `YYYY-MM-DD` |
| 4 | **Đơn vị khối lượng** của `grossWeight`: kg hay g? Có cần gửi kèm mã đơn vị (`KGM`)? | Nhãn ghi "Gross weight (kg)" nhưng chưa xác nhận với SAP | kg, không gửi mã đơn vị |
| 5 | **Mã kho / plant / storage location**: `warehouse` hiện là chuỗi tự do ("Kho Long Biên"). SAP cần mã gì (`1000`/`0001`)? Ai giữ bảng ánh xạ? | Không có bảng này thì mọi phiếu sẽ `SAP_LOCATION_LOCKED` hoặc tệ hơn | Cần bảng ánh xạ; **chặn** Phase 7 |
| 6 | **Reversal (huỷ phiếu đã posted)**: có API không? Cần `sapDocumentNo` hay `receiptId`? Có giới hạn thời gian (cùng kỳ kế toán)? | Trạng thái `cancelled` của phiếu đã `posted` phụ thuộc câu này | Có API reversal theo `sapDocumentNo`, giới hạn trong ngày |
| 7 | **Đơn hàng (PO/ASN)**: phiếu nhập có bắt buộc gắn PO không? Nếu có, lấy số PO ở đâu — trên nhãn hay tra theo `partNumber`? | Quyết định `SAP_QTY_EXCEEDS_PO` có bao giờ xảy ra không, và có cần thêm trường vào form | Chưa gắn PO (giả định §7.4 của `REVIEW_AND_ROADMAP.md`) |
| 8 | **Danh sách mã lỗi nghiệp vụ thật** của SAP, và cách phân biệt chúng với lỗi kỹ thuật trong response | Bốn mã ở §3 là **do tài liệu này đặt ra**, không phải mã thật của SAP | Dùng 4 mã ở §3 làm mã nội bộ, map từ mã SAP thật khi có |
| 9 | **Tần suất và giới hạn**: SAP có rate limit không? Gửi từng phiếu ngay có chấp nhận được, hay phải gom batch theo ca? | Thiết kế hiện tại gửi **từng phiếu ngay** qua outbox | Gửi từng phiếu, không gom batch (giả định §7.5) |
| 10 | **Môi trường test**: có hệ thống QAS/sandbox để nối thử không, hay chỉ có production? | Không có sandbox thì Phase 7 không thể kiểm chứng trước khi chạy thật | Giả định có sandbox |

Câu 1, 5 và 10 là **chặn cứng**: thiếu bất kỳ câu nào trong ba câu đó thì không nối SAP thật được, dù
code đã xong.


## 9. Giới hạn đã biết của mock — nói thẳng trước khi ai đó tin nhầm

| Giới hạn | Hệ quả quan sát được | Chấp nhận được vì |
|---|---|---|
| Map `issued` (`receiptId → sapDocumentNo`) nằm **trong RAM tiến trình BE** | Khởi động lại BE là map **mất sạch**. Gửi lại cùng một `receiptId` sau khi restart sẽ nhận một `sapDocumentNo` **khác** | Đây là mock, không phải SAP. Tính idempotent thật là **yêu cầu đặt ra cho SAP** (§6, câu 1 ở §8), không phải tính chất mà mock chứng minh thay được |
| `seq` bắt đầu từ `1` và cũng nằm trong RAM | Khởi động lại BE → `sapDocumentNo` quay về `5000000001`, **trùng** với chứng từ đã cấp trước đó | Không có bên thứ ba nào đọc con số này ở Phase 4 |
| Mock **không có persistence** | Không truy vấn lại được "SAP đã nhận những phiếu nào" sau khi restart. Nguồn sự thật duy nhất là `receipts.sap_document_no` và `receipt_events` trong SQLite | Đúng như thiết kế: adapter **không lưu gì**, **không** đổi trạng thái phiếu, **không** ghi `receipt_events` |
| Phase 4 giả định **đúng một tiến trình BE** | Hai tiến trình BE trên cùng file SQLite có nguy cơ cùng nhặt một job outbox và gửi trùng. `busy_timeout=3000` + điều kiện `WHERE state='pending'` làm giảm rủi ro nhưng **không loại bỏ** | Đã ghi vào rủi ro dự án. Khoá phân tán là việc của Phase 6 |
| Mock chỉ đọc kịch bản **toàn cục** | Không mô phỏng được "SAP hỏng riêng với PDA này" | Không có nghĩa nghiệp vụ — xem §7 |

Hai giới hạn đầu là lý do **không** được dùng SAP mock để nghiệm thu tính idempotent *của hệ thống
thật*. Nó chỉ chứng minh rằng **phía BE** gọi đúng một lần cho mỗi phiếu.

---