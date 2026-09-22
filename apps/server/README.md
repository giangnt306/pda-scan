# Main Backend (`@pda-scan/server`)

Node.js thuần: `node:http` + `node:sqlite` + parser multipart có sẵn của fetch API.
Không có dependency npm. Yêu cầu Node ≥ 22.13.

## Chạy

```bash
npm run dev --workspace @pda-scan/server     # node --watch
npm run start --workspace @pda-scan/server
npm test --workspace @pda-scan/server        # node:test
```

`npm test` cho **94 pass / 0 fail** tại thời điểm **2026-09-21 22:49 (+07)** (đo bằng
`npm run test:server | grep '^# pass'`). Bộ test đang lớn lên từng giờ theo Phase 3 — chạy lại lệnh
trên để lấy số hiện tại thay vì tin dòng này.

Cấu hình qua biến môi trường hoặc file `apps/server/.env` (xem `.env.example`). Mặc định **trong
code** là `127.0.0.1:3000`, nhưng **`apps/server/.env` trong repo đang đặt `HOST=0.0.0.0`**, nên BE
trả lời cả trên địa chỉ LAN chứ không chỉ loopback. Đặt `HOST=127.0.0.1` nếu muốn PDA chỉ đi qua
Vite proxy.

## Bố cục

```text
src/index.js                  Khởi động, tắt sạch khi SIGINT/SIGTERM
src/app.js                    Lắp ráp db + storage + services + http (dùng chung cho test)
src/config.js                 Đọc .env / process.env, giá trị mặc định, enum mode hợp lệ
src/db.js                     Schema SQLite 9 bảng + migrate() idempotent
src/storage.js                Lớp lưu ảnh: sniff magic bytes, tên file do server tạo, getBuffer/publicUrl
src/fields.js                 Schema trường, ép kiểu, validation, chuẩn hoá kết quả nhận dạng
src/devices.js                Đăng ký thiết bị, heartbeat, tính status online/stale/offline
src/sessions.js               Mở/đóng phiên làm việc, tính summary bằng SQL lúc đọc
src/status.js                 GET /api/status: gộp backend + probe OCR (cache 10 s) + queue + sim
                              + sap (P4) + khối recognition 5 khoá (P5)
src/events.js                 Sổ sự kiện toàn hệ system_events: 31 loại, 3 severity, VÒNG XOAY
src/lifecycle.js              P4 — MODULE DUY NHẤT được ghi receipts.status + receipt_events
src/outbox.js                 P4 — CHỈ đụng bảng outbox: enqueue/due/requeue/giveUp/pendingCount
src/outboxWorker.js           P4 — worker nền 1000 ms, 5 attempt, backoff 5/15/60/60 s
src/sap/adapter.js + mock.js  P4 — interface SAP + mock 4 mode, ĐÚNG 2 lớp lỗi
src/master.js                 P4 — danh mục vị trí/kho/ca, nạp MỘT LẦN lúc khởi động vào RAM
src/rules/                    P4 — quy tắc nghiệp vụ: vị trí trước, trùng nhãn sau
src/routes/                   Điểm cắm: master.js (3) + rules.js (2) + admin.js (2) → 7 route
src/receipts.js               Tạo/đọc bản ghi, idempotency theo requestId
src/recognition/service.js    Sở hữu recognitionId, trạng thái, timeout, retry, lưu raw + normalized
src/recognition/semaphore.js  Giới hạn số recognition chạy song song + hàng đợi FIFO → 429 khi đầy
src/recognition/providers/    mock.js và http.js (gọi ai-server) — cùng contract
src/recognition/asyncJobs.js  P5 — job nhận dạng nền cho RECOGNITION_MODE=async
src/sim/engine.js             Đọc/ghi bảng sim_state, trộn SIM_DEFAULT < global < device < request
src/sim/middleware.js         Áp backend.mode (degraded/readonly/down) cho toàn bộ request
src/sim/ocrWrapper.js         Áp 7 ocr.mode lên provider ĐANG DÙNG (mock hay http đều vậy)
src/http.js                   Router 22 route lõi (+7 từ src/routes = 29), body limit, mã lỗi
src/log.js                    Log JSON một dòng mỗi sự kiện, luôn kèm requestId
test/                         fields, api, limits, persistence, providers, devices, sessions,
                              sim, status, concurrency, contract (+ helpers.js, schema-validator.js)
```

## Dữ liệu

- `data/pda-scan.sqlite` — WAL mode, `PRAGMA foreign_keys=ON`, `busy_timeout=3000`.
- `data/uploads/<uuid>.<ext>` — ảnh gốc; DB giữ mime, bytes, sha256.
- Log: một dòng JSON mỗi sự kiện; chỉ có định danh và kích thước, không có nội dung ảnh.

Chín bảng sau migration: `images`, `recognitions`, `receipts` (Phase 1–2) · `devices`, `sessions`,
`sim_state` (Phase 3) · `receipt_events`, `outbox` (Phase 4) · `system_events` (Phase 5).
Kiểm lại: `grep -c 'CREATE TABLE' src/db.js`.
`openDb()` chạy `CREATE TABLE IF NOT EXISTS` rồi `migrate()` ở **mỗi** lần mở, và `migrate()` chỉ
`ADD COLUMN` khi `PRAGMA table_info` cho thấy cột chưa có — nên mở một DB cũ không mất dòng nào.
Chi tiết từng cột: [docs/data-model.md](../../docs/data-model.md).

## Hợp đồng API

Xem [docs/api.md](../../docs/api.md) (cho người đọc) và [docs/openapi.yaml](../../docs/openapi.yaml)
(máy đọc được). Toàn bộ **29 route** đang chạy (bảng dưới liệt kê các nhóm chính; danh sách đầy đủ
và chính xác nằm trong `openapi.yaml`, và `test/contract.test.js` khoá hai bên khớp nhau theo **cả
hai chiều**):

### Nhận dạng và bản ghi

| Method | Path | Mục đích |
|---|---|---|
| GET | `/api/health` | 8 field: `ok, uptimeSec, provider, mockMode, simOverride, simSaveFail, db, receipts` |
| POST | `/api/recognitions` | multipart `image` → `recognitionId` + `fields` + `fieldsFound`; 429 khi hàng đợi đầy |
| GET | `/api/recognitions/:id` | đọc lại một lần nhận dạng |
| GET | `/api/images/:id` | ảnh gốc (cho người xem lại, hoặc cho AI server nếu gửi bằng URL) |
| POST | `/api/receipts` | lưu bản ghi đã xác nhận; idempotent theo `requestId` |
| GET | `/api/receipts` | danh sách; `limit`, `sessionId`, `deviceId`, `status`, `cursor` (keyset); trả thêm `nextCursor`, `counts`, `serverTime` |
| GET | `/api/receipts/:id` | đọc lại một bản ghi |
| GET | `/api/receipts/:id/events` | `P4` — sổ sự kiện của riêng phiếu đó |
| POST | `/api/receipts/:id/retry-post` | `P4` — xếp lại job gửi SAP; `202` rồi FE poll phiếu |
| POST | `/api/receipts/:id/cancel` | `P4` — huỷ phiếu; phiếu đã `posted` sinh job đảo chứng từ |
| POST | `/api/receipts/:id/correct` | `P4` — tạo phiếu sửa thay thế phiếu cũ |
| GET | `/api/master/locations` · `/warehouses` · `/shifts` | `P4` — danh mục dữ liệu chủ, đọc từ RAM |

### Thiết bị và phiên làm việc

| Method | Path | Mục đích |
|---|---|---|
| POST | `/api/devices/register` | đăng ký/cập nhật thiết bị, idempotent. `201` lần đầu, `200` các lần sau |
| POST | `/api/devices/:id/heartbeat` | báo sống mỗi 15 s. `:id` chưa đăng ký → `404 DEVICE_NOT_FOUND` |
| GET | `/api/devices` | danh sách thiết bị + `counts` online/stale/offline, sắp xếp `last_seen DESC` |
| POST | `/api/sessions/start` | mở phiên; tự đóng phiên cũ của cùng thiết bị (`end_reason = "superseded"`) |
| POST | `/api/sessions/:id/end` | đóng phiên; gọi lại trên phiên đã đóng → `200` kèm `alreadyEnded: true` |
| GET | `/api/sessions/:id` | đọc phiên + `summary` (đếm bằng SQL lúc đọc, không lưu sẵn) |
| POST | `/api/devices/:deviceId/events` | `P5` — PDA gửi **lô** sự kiện quan sát, tối đa **20**/lô, chỉ **5 loại** được phép. Validate **cả lô hoặc không gì cả**. **KHÔNG** được miễn sim middleware: `backend.mode="readonly"` chặn nó bằng `503`, và đó là hành vi đúng |

`POST /api/recognitions` và `POST /api/receipts` ghi kèm `device_id`/`session_id` lấy từ **header**
(`x-device-id`, `x-session-id`), không lấy từ body. Thiếu header thì lưu `NULL` — trừ khi
`REQUIRE_DEVICE_ID=true`.

### Trạng thái và quản trị kịch bản

| Method | Path | Mục đích |
|---|---|---|
| GET | `/api/status` | trạng thái `backend` · `ocr` · `sap` · `queue` · `sim` + `serverTime` + `version` |
| GET | `/api/admin/sim` | kịch bản `default` / `global` / theo từng device |
| PUT | `/api/admin/sim` | đặt kịch bản global (patch từng phần) |
| DELETE | `/api/admin/sim` | xoá kịch bản global |
| PUT | `/api/admin/sim/devices/:deviceId` | đặt kịch bản cho một thiết bị |
| DELETE | `/api/admin/sim/devices/:deviceId` | xoá kịch bản của một thiết bị |
| GET | `/api/admin/events` | `P5` — sổ sự kiện toàn hệ. `since` là con trỏ **tăng đơn điệu**; `since=0` nghĩa là "`limit` dòng **mới nhất**", **không phải** "từ đầu bảng" |
| GET | `/api/admin/recognitions` | `P5` — hàng đợi nhận dạng gần nhất, cho màn hình giám sát |

`/api/status` và `/api/admin/*` **không bị sim middleware chặn**: kể cả khi `backend.mode=down` thì
hai đường này vẫn trả lời, nếu không sẽ không còn cách nào tắt kịch bản. `/api/health` thì **bị
chặn** — đó là chủ ý, nó mô phỏng máy chủ chết thật.

Khi `SIM_OVERRIDE=false`, mọi `/api/admin/sim*` trả `403 SIM_DISABLED`, kể cả `GET`.

### Header

| Header | Ai sinh | Ghi chú |
|---|---|---|
| `x-device-id` | FE | UUID v4 chữ thường. Sai định dạng → `400 INVALID_DEVICE_ID` |
| `x-session-id` | FE | tuỳ chọn ở Phase 3 |
| `x-request-id` | FE, **BE tự sinh nếu thiếu hoặc sai** | BE **luôn** trả lại header này, kể cả trên response lỗi và response ảnh |
| `x-app-version` | FE | để ghi log |

## Biến môi trường

Danh sách đầy đủ và bình luận nằm trong [`.env.example`](.env.example); bảng dưới là mặc định
**trong code** (`src/config.js`).

| Biến | Mặc định trong code | Ý nghĩa |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Địa chỉ bind. `.env` của repo đang đặt `HOST=0.0.0.0` |
| `DATA_DIR` | `./data` | SQLite + `uploads/`, tương đối so với `apps/server` |
| `MAX_UPLOAD_BYTES` | `10485760` | Giới hạn upload (10 MB) |
| `CORS_ORIGINS` | rỗng | Origin được gọi thẳng `/api`. Rỗng = tắt CORS |
| `RECOGNITION_PROVIDER` | `mock` | `mock` \| `http`. `.env` của repo đang đặt `http` |
| `RECOGNITION_TIMEOUT_MS` | `20000` | Ngân sách timeout **dùng chung cho cả 2 attempt**. `.env` của repo đang đặt `45000` |
| `RECOGNITION_MAX_ATTEMPTS` | `2` | Tổng số lần gọi provider (1 + 1 retry) |
| `RECOGNITION_RETRY_BACKOFF_MS` | `500` | Chờ trước attempt 2, cố định, không jitter |
| `RECOGNITION_MAX_CONCURRENT` | `3` | Số recognition chạy đồng thời |
| `RECOGNITION_MAX_WAITING` | `10` | Số request được xếp hàng chờ slot |
| `RECOGNITION_MAX_WAIT_MS` | `30000` | Chờ tối đa trong hàng đợi rồi `429` |
| `RECOGNITION_BUSY_RETRY_AFTER_MS` | `3000` | `retryAfterMs` trả kèm `429 RECOGNITION_BUSY` |
| `OCR_PROBE_TIMEOUT_MS` | `3000` | Timeout khi probe `GET /health` của ai-server (kết quả cache 10 s) |
| `REQUIRE_DEVICE_ID` | `false` | `true` → thiếu `x-device-id` trên 2 endpoint nghiệp vụ là `400 DEVICE_REQUIRED` |
| `MOCK_MODE` | `success` | `success` \| `slow` \| `error` \| `timeout`, chỉ khi `provider=mock` |
| `MOCK_DELAY_MS` / `MOCK_SLOW_DELAY_MS` | `700` / `6000` | Độ trễ của mock |
| `SIM_OVERRIDE` | `true` | Bật scenario engine + `/api/admin/sim*`. **Đặt `false` khi chạy thật** |
| `SIM_SAVE_FAIL` | `false` | Mọi lần lưu đều `503`; thắng mọi nguồn kịch bản khác cho `save.mode` |
| `AI_SERVER_URL` | rỗng | Nơi `providers/http.js` POST ảnh. Rỗng + `provider=http` → `503 PROVIDER_NOT_CONFIGURED` |
| `AI_SERVER_API_KEY` | rỗng | Shared secret gửi dạng `authorization: Bearer …` |
| `PUBLIC_BASE_URL` | rỗng | Có thì gửi kèm `imageUrl` để AI server tự tải ảnh |
| `RECOGNITION_MODE` `P5` | `sync` | `sync` \| `async`. `async` → `POST /api/recognitions` trả `202` + `pollUrl` rồi chạy nền. Mặc định `sync` là **bắt buộc**: bật async mặc định làm mọi test cũ (kỳ vọng `201` + `fields`) đỏ hàng loạt |
| `RECOGNITION_POLL_HINT_MS` `P5` | `1000` (kẹp 200..10000) | Giá trị `pollAfterMs` và `retry-after` trả kèm `202` |
| `SAP_ADAPTER` `P4` | `mock` | `mock` \| `none`. Chưa có `http` — SAP thật là Phase 7 |
| `SAP_TIMEOUT_MS` `P4` | `15000` (sàn 1000) | Timeout **mỗi attempt** gửi SAP |
| `SAP_MAX_ATTEMPTS` `P4` | `5` (kẹp 1..10) | Hết lượt → phiếu sang `post_failed` |
| `SAP_MOCK_SUCCESS_DELAY_MS` / `SAP_MOCK_SLOW_DELAY_MS` `P4` | `300` / `8000` | Độ trễ của SAP mock |
| `OUTBOX_ENABLED` `P4` | `true` | Tắt worker nền (dùng trong test) |
| `OUTBOX_TICK_MS` `P4` | `1000` (kẹp 20..60000) | Chu kỳ quét job tới hạn; mỗi tick lấy tối đa 10 job |
| `OUTBOX_BACKOFF_MS` `P4` | `5000,15000,60000,60000` | **Đúng 4 giá trị**, ứng với 4 lần retry |
| `RULE_DUPLICATE` / `RULE_LOCATION` `P4` | `true` / `true` | Bật hai quy tắc nghiệp vụ trước khi lưu |
| `TZ_OFFSET_MINUTES` `P4` | `420` | Ngày **địa phương** của kho dùng cho khoá chống trùng nhãn. Mốc thời gian **lưu trữ** vẫn là UTC |
| `EVENTS_ENABLED` `P5` | `true` | Bật sổ sự kiện toàn hệ `system_events` |
| `EVENTS_MAX_ROWS` `P5` | `2000` (kẹp 100..100000) | **Vòng xoay**: quá trần thì cắt dòng cũ |
| `EVENTS_TRIM_EVERY` `P5` | `100` (kẹp 1..10000) | Cắt sau mỗi bao nhiêu lần ghi |
| `EVENTS_MIRROR_RECEIPTS` `P5` | `true` | Phản chiếu sự kiện vòng đời phiếu sang sổ toàn hệ |
| `MASTER_DIR` `P4` | `src/master-data` | Danh mục tĩnh nằm trong `src/` chứ **không** trong `DATA_DIR`: nó là mã nguồn có version |

## Kịch bản mô phỏng (scenario engine)

Bốn nhóm, mỗi nhóm một `mode` và một số mili-giây:

| Nhóm | Mode hợp lệ | Số |
|---|---|---|
| `backend` | `normal` · `degraded` · `readonly` · `down` | `latencyMs` 0..30000 |
| `ocr` | `success` · `slow` · `error` · `timeout` · `partial` · `garbage` · `lowConfidence` | `delayMs` 0..30000 |
| `save` | `normal` · `fail` · `slow` | `latencyMs` 0..30000 |
| `sap` | `success` · `slow` · `reject` · `down` | `latencyMs` 0..30000 — **từ Phase 4 có tác dụng THẬT** lên SAP mock. Chỉ đọc kịch bản **toàn cục**, không đọc kịch bản theo thiết bị (QUYẾT ĐỊNH L9) |

Thứ tự ưu tiên khi trộn, từ thấp đến cao:
`SIM_DEFAULT` → `MOCK_MODE` (chỉ `ocr.mode`, chỉ provider mock) → `sim_state` scope `global` →
`sim_state` scope `device:<id>` → query `?sim=` / `?simSave=` → `SIM_SAVE_FAIL=true` (chỉ `save.mode`).
Trộn ở **cấp field**, nên đặt `device: {ocr:{mode:"error"}}` không xoá `ocr.delayMs` của global.

`sim/ocrWrapper.js` bọc provider **đang dùng**, nên 7 mode OCR áp cho cả `mock` lẫn `http`.
`partial` xoá đúng 3 trường `partNumber` / `shipmentDate` / `supplier` (cố định, không ngẫu nhiên).

> `ocr.mode = garbage` **không** cho ra `status: "unparsed"` ở `partNumber`: `coerce()` với
> `type: "code"` luôn nhận giá trị, chỉ kẹp `confidence ≤ 0.5`. Trường bị `unparsed` là `quantity`
> (vì `"??"` không ép được sang integer). Đây là hành vi cố ý từ Phase 1 — giữ giá trị để người vận
> hành sửa một ký tự thay vì xoá trắng (hợp đồng Phase 3, ĐÍNH CHÍNH R1).

## Provider `http` (gọi AI server)

1. Đặt `RECOGNITION_PROVIDER=http`, `AI_SERVER_URL`, (tuỳ) `AI_SERVER_API_KEY`, `PUBLIC_BASE_URL`.
2. `providers/http.js` POST multipart (`image`, `recognitionId`, kèm `imageUrl` nếu có
   `PUBLIC_BASE_URL`) và chuyển tiếp `x-request-id` sang ai-server.
3. Không cần đổi frontend, service, DB hay validation.

Chuỗi timeout phải **giảm dần từ ngoài vào trong**: webapp 60000 > BE `RECOGNITION_TIMEOUT_MS`
20000 > ai-server `UPSTREAM_TIMEOUT_MS` 18000. Đặt lệch thì nhánh ánh xạ `UPSTREAM_TIMEOUT` →
`RECOGNITION_TIMEOUT` không bao giờ chạy (hợp đồng Phase 3, ĐÍNH CHÍNH R2).

Ánh xạ lỗi upstream → mã BE trả cho PDA:

| Tình huống ở provider | BE trả |
|---|---|
| ai-server `504` hoặc body `error.code === "UPSTREAM_TIMEOUT"` | `504 RECOGNITION_TIMEOUT` |
| `AbortSignal` của BE bắn (quá `RECOGNITION_TIMEOUT_MS`) | `504 RECOGNITION_TIMEOUT` |
| ai-server 5xx/429, JSON hỏng, kết nối hỏng (sau khi hết retry) | `502 RECOGNITION_FAILED` |
| ai-server `503 NOT_CONFIGURED`, hoặc BE thiếu `AI_SERVER_URL` | `503 PROVIDER_NOT_CONFIGURED` |
| Hàng đợi đầy | `429 RECOGNITION_BUSY` kèm `retry-after` |

Chi tiết và danh sách thông tin cần AI team cung cấp: [docs/api.md](../../docs/api.md#phase-2-điểm-cắm-ai-server).

## Test

`test/contract.test.js` đối chiếu output **code thật** (`recognizeWithLlm` và `recognizeSimulated`
của ai-server, raw result của mock provider) với
[`docs/contracts/ocr-response.schema.json`](../../docs/contracts/ocr-response.schema.json), dùng
validator draft-07 tự viết ở [`test/schema-validator.js`](test/schema-validator.js) (0 dependency
npm). Validator có test chiều âm: dữ liệu thiếu `required`, sai `type`, thừa key, sai `enum`, mảng
sai độ dài đều phải bị bắt — nếu không thì validator vô dụng.
