# AI Server (`@pda-scan/ai-server`)

Dịch vụ OCR nhãn tạm thời dùng **LLM có vision** qua API Chat Completions chuẩn OpenAI.
Node.js thuần, không dependency npm. Main Backend gọi tới đây khi
`RECOGNITION_PROVIDER=http`; webapp không biết dịch vụ này tồn tại.

## Chọn API (free)

| Lựa chọn | Model | Ghi chú |
|---|---|---|
| **OpenAI** (khuyên dùng vì bạn đang có quota) | `gpt-4o-mini` | Vision + JSON schema strict. Đo thật: ảnh 720×1280 `detail=high` ≈ **37,4k prompt token** (4o-mini nhân hệ số token ảnh), 5,4 s; ảnh gốc 4031×3023 tốn token tương đương (API tự thu nhỏ trước khi chia ô) nhưng mất 15 s và đọc kém hơn. Số token đo từ `usage` thật; **chi phí quy ra tiền không ghi ở đây** vì phụ thuộc bảng giá từng nhà cung cấp và không kiểm chứng được trong repo |
| Google Gemini free tier | `gemini-2.0-flash` (hoặc bản flash mới hơn) | Dùng endpoint tương thích OpenAI `https://generativelanguage.googleapis.com/v1beta/openai`. Key tại aistudio.google.com |

Đổi nhà cung cấp = đổi `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`; không sửa code.
Nếu API không hỗ trợ `response_format: json_schema` thì nó trả HTTP 400 — mỗi nhà cung cấp một kiểu
body (vLLM, Azure, body rỗng…), nên server tự lùi về `json_object` với **mọi** HTTP 400 ở lần gọi đầu,
đúng **một** lần. Đây là *lùi định dạng*, không phải *retry lỗi tạm* (xem mục Truy vết, timeout và retry).

## Chạy

```bash
cp ai-server/.env.example ai-server/.env   # dán OPENAI_API_KEY vào
npm run dev            # từ root: webapp (Vite proxy /api → ai-server)
npm run dev:ai         # chỉ AI server
npm run test:ai
curl -s http://127.0.0.1:8000/health
curl -s -X POST -F "image=@label.jpg" http://127.0.0.1:8000/recognize | jq
```

Main Backend cần `apps/server/.env`:

```
RECOGNITION_PROVIDER=http
AI_SERVER_URL=http://127.0.0.1:8000/recognize
RECOGNITION_TIMEOUT_MS=20000     # phải LỚN HƠN UPSTREAM_TIMEOUT_MS (18000) của ai-server
```

Muốn quay lại mock: đổi `RECOGNITION_PROVIDER=mock` (hoặc xoá dòng đó) và khởi động lại BE.
`WITHOUT_AI=1 npm run dev` để không khởi động AI server.

## Giả lập dịch vụ OCR hỏng — `OCR_SIM_MODE` (không tốn quota)

`OCR_SIM_MODE` khác `passthrough` thì AI server **không gọi OpenAI** và **không cần `OPENAI_API_KEY`**:
dữ liệu trả về là mẫu cố định trong `src/sim.js`, `model = "sim-<mode>"`, `usage = null`.
Đây là env của **tiến trình** (mô phỏng cả dịch vụ hỏng), khác với kịch bản theo thiết bị/request
của Main BE (`sim/ocrWrapper.js` — mô phỏng "OCR đọc ra kết quả kém").

| `OCR_SIM_MODE` | AI server trả | Main BE thấy |
|---|---|---|
| `passthrough` (mặc định) | gọi LLM thật | như thường |
| `slow` | 200 sau `OCR_SIM_DELAY_MS` (25000) | quá 18 s → ai-server `504 UPSTREAM_TIMEOUT` → BE `504 RECOGNITION_TIMEOUT` |
| `error` | `502 UPSTREAM_ERROR`, `upstreamStatus: 500` | `502 RECOGNITION_FAILED` |
| `timeout` | treo tới `UPSTREAM_TIMEOUT_MS` rồi `504 UPSTREAM_TIMEOUT` | `504 RECOGNITION_TIMEOUT` |
| `partial` | 200, chỉ `qty`/`part_name`/`batch` có chữ | 6 trường `missing`, gồm trường bắt buộc |
| `garbage` | 200, chữ rác cố định + `rawText` rác | theo ĐÍNH CHÍNH R1: `partNumber` `ok` nhưng confidence bị kẹp ≤ 0.5, `partName` `ok`, `quantity` `unparsed` |

```bash
OCR_SIM_MODE=partial OPENAI_API_KEY= PORT=8010 node ai-server/src/index.js &
curl -s -F image=@sample/image.jpeg -H 'x-request-id: test-req-000001' http://127.0.0.1:8010/recognize
```

Sai chính tả mode → server **không khởi động được** và báo đủ 6 giá trị hợp lệ (fail-fast).

## Truy vết, timeout và retry

- `x-request-id`: nhận từ Main BE (thiếu thì tự sinh), có trong **mọi** dòng log (`ocr.start`,
  `ocr.retry`, `ocr.done`, `ocr.failed`, `ocr.timeout`), trong response header và trong `body.requestId`.
- `UPSTREAM_TIMEOUT_MS` mặc định **18000**. Chuỗi timeout phải **giảm dần từ ngoài vào trong**:
  webapp `60000` > Main BE `RECOGNITION_TIMEOUT_MS=20000` > ai-server `18000` > (LLM). Khoảng đệm
  2000 ms để ai-server kịp trả `504 UPSTREAM_TIMEOUT` có cấu trúc **trước khi** BE tự bỏ cuộc — nhờ đó
  BE ánh xạ được thành `504 RECOGNITION_TIMEOUT` và người vận hành biết là *OCR chậm*, không phải
  *BE bỏ cuộc*. Đặt bằng hoặc lớn hơn ngân sách BE là làm chết nhánh ánh xạ đó.
- **Lùi định dạng** (khác retry, không tính vào `retryCount`): lần gọi đầu dùng `json_schema`; gặp
  **bất kỳ** HTTP 400 nào thì gọi lại **đúng một lần** với `json_object`. Không lọc theo nội dung body,
  vì mỗi nhà cung cấp viết lỗi 400 một kiểu — đó là điều giữ cho lời hứa "đổi nhà cung cấp chỉ cần đổi
  3 biến env" là thật.
- **Retry lỗi tạm** 1 lần, backoff 500 ms: HTTP 429, HTTP 5xx, `BAD_RESPONSE` (JSON hỏng),
  `TRUNCATED` (bị cắt vì `max_tokens`), lỗi kết nối. **Không** thử lại với 400/401/403,
  `NOT_CONFIGURED`, và khi đã hết thời gian (cả 2 lần dùng chung một `AbortSignal`, chỉ thử lại khi
  còn ≥ 2000 ms). Số lần thử lại nằm ở `body.retryCount` và trong log.
- `MAX_OUTPUT_TOKENS` mặc định 900 và prompt chỉ xin `raw_text` ≤ 10 dòng (server còn cắt cứng
  10 dòng lúc chuẩn hoá) để giảm lỗi `TRUNCATED` từng gặp thật.

## Contract

`POST /recognize` — `multipart/form-data`: `image` (JPEG/PNG/WebP, kiểm tra magic bytes, ≤ 10 MB),
`recognitionId` (tuỳ chọn). Header `Authorization: Bearer <AI_SERVER_API_KEY>` nếu đặt shared secret.

```json
{
  "recognitionId": "…", "requestId": "9f2a41c6-2e6b-4a13-b0a9-2f45a1f8b7c3",
  "durationMs": 5321, "model": "gpt-4o-mini-2024-07-18",
  "simMode": "passthrough", "retryCount": 0,
  "fields": [
    { "name": "part_number", "text": "BEX32181030AB", "score": 0.94 },
    { "name": "qty",         "text": "80",            "score": 0.91 },
    { "name": "ship_date",   "text": "15/9/2026",     "score": 0.62 },
    { "name": "sa_number",   "text": null,            "score": 0 }
  ],
  "rawText": "tối đa 10 dòng chữ đọc được…",
  "usage": { "prompt_tokens": 37412, "completion_tokens": 210, "total_tokens": 37622 }
}
```

`model` là model **thật** do API trả về; `simMode`/`retryCount`/`requestId` là field thêm ở Phase 3
(tương thích ngược). `GET /health` trả
`{ ok, model, baseUrl, configured, ready, authRequired, simMode, upstreamTimeoutMs }`:

| Trường | Ý nghĩa |
|---|---|
| `configured` | **Có `OPENAI_API_KEY` hay không.** Chỉ mang tính thông tin. |
| `ready` | **Có phục vụ được `/recognize` hay không** = `configured === true` **HOẶC** `simMode !== "passthrough"`. FE quyết định màu đèn OCR bằng trường này, **không** phải `configured`. |
| `simMode` | Giá trị `OCR_SIM_MODE` hiện tại. |
| `upstreamTimeoutMs` | Timeout đang dùng, để BE kiểm được chuỗi timeout giảm dần. |

Hệ quả cần nhớ: ở cấu hình demo không tốn quota (`OCR_SIM_MODE` khác `passthrough`, **không** có key)
thì `configured: false` nhưng `ready: true` — đèn OCR trên PDA phải **xanh**, vì `/recognize` chạy thật.

`fields` luôn đủ 10 tên: `part_number part_name qty ship_date supplier sa_number variant plant_dock batch gross_weight`.
`text` là chuỗi **đúng như in trên nhãn** (không tự đổi định dạng ngày/số); Main BE mới ép kiểu.
Model không nhìn thấy `location`/`packaging`/`note` vì đó là dữ liệu người vận hành nhập.

Lỗi: `{ "error": { "code", "message", "upstreamStatus"? } }` với
`401 UNAUTHORIZED` · `415 UNSUPPORTED_IMAGE` · `413 IMAGE_TOO_LARGE` · `503 NOT_CONFIGURED` (thiếu key) ·
`502 UPSTREAM_ERROR` (LLM trả 4xx/5xx, ví dụ 429 hết quota) · `504 UPSTREAM_TIMEOUT`.
Mọi response (kể cả lỗi) đều mang header `x-request-id`.
Main BE ánh xạ: `504`/`UPSTREAM_TIMEOUT` → `504 RECOGNITION_TIMEOUT`, `503 NOT_CONFIGURED` →
`503 PROVIDER_NOT_CONFIGURED`, còn lại → `502 RECOGNITION_FAILED` kèm message gốc.

## Bố cục

```text
src/index.js    khởi động, tắt sạch
src/config.js   .env + mặc định (fail-fast cho OCR_SIM_MODE sai)
src/server.js   /health, /recognize, kiểm tra ảnh, shared secret, x-request-id, rẽ nhánh sim
src/ocr.js      prompt, JSON schema, gọi chat/completions, retry, chuẩn hoá output
src/sim.js      mẫu dữ liệu + 5 mode giả lập OCR hỏng (không gọi mạng)
test/           28 test với fetch giả, không gọi OpenAI thật
```

## Kết quả đo với nhãn mẫu (`sample/image.jpeg`, 2026-09-21)

| Ảnh | Thời gian | Đúng | Ghi chú |
|---|---|---|---|
| 720×1280 (kích cỡ webapp gửi) | 5,4 s | 7/7 trường có trên nhãn | ≈ 37,4k prompt token; `VINFAST` → nhà cung cấp nội bộ nhờ alias phía BE |
| 4031×3023 gốc | 15 s | 6/7 | part number bị thêm một số 0 → BE kẹp confidence 0.5, validation chặn khi lưu |

Độ trễ nhiều lần gọi: p50 5,3 s · p90 7,6 s · max 15,2 s → `UPSTREAM_TIMEOUT_MS=18000` là đủ
(và vẫn thấp hơn ngân sách 20000 của Main BE, đúng thứ tự giảm dần).

`score` model tự báo gần như luôn 0.9–1.0, chưa dùng được để phân biệt chắc/không chắc.

## Giới hạn

- Ảnh gửi dạng base64 trong request LLM; ảnh 150 KB → ~200 KB JSON. Không lưu ảnh ở đây.
- Chất lượng đọc phụ thuộc model; `score` do model tự ước lượng, chưa hiệu chỉnh.
- Đây là giải pháp tạm; khi có OCR/VLM chuyên dụng, chỉ cần dịch vụ đó trả cùng contract, hoặc
  sửa `mapAiResponse` trong `apps/server/src/recognition/providers/http.js`.
