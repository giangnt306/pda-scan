# Thiết bị ảo và bộ chạy kịch bản

Diễn lại mọi tình trạng của thiết bị quét và Main Backend **mà không làm hỏng thứ gì thật**.
Không phụ thuộc gói npm nào — chỉ `node:` builtin, Node ≥ 22.13, ESM.

```
lib/            args · rng · fixtures · client · device · fleet · stats · expect · events · report · proc
scenarios/      6 kịch bản mẫu (JSON)
test/           node --test, chạy được không cần máy chủ
run-scenario.js chạy MỘT kịch bản rồi tự chấm; mã thoát = kết luận
virtual-devices.js  CLI thiết bị ảo độc lập
sandbox.js      dựng máy chủ riêng (cổng + DATA_DIR tạm), chạy kịch bản, dọn sạch
```

## `--base` là BẮT BUỘC — không có cổng mặc định

`run-scenario.js` và `virtual-devices.js` **không** đoán máy chủ đích. Thiếu `--base` thì chúng
in hướng dẫn và thoát **2**, không gửi một request nào.

```
$ node scripts/sim/run-scenario.js backend-down-30s
Thiếu --base. Bộ công cụ mô phỏng KHÔNG còn cổng mặc định.
…
  1) Để hộp cát tự dựng máy chủ RIÊNG (cổng trống ngẫu nhiên + DATA_DIR tạm, tự dọn):
     node scripts/sim/sandbox.js --server-entry apps/server/src/index.js --scenario <tên>
  2) Hoặc nói rõ máy chủ đích:
     node scripts/sim/run-scenario.js <tên> --base http://127.0.0.1:<39000-39999>
$ echo $?
2
```

Trước đây mặc định là `http://127.0.0.1:39117`. Cổng đó nằm **trong** dải mô phỏng nên cảnh báo
`isOutsideSimPortRange` không bao giờ kêu, mà nó lại đúng bằng cổng playbook bảo người demo
dùng: một lệnh gõ thiếu `--base` sẽ hạ máy chủ của người khác trong 30 giây. Rào chắn cổng vẫn
còn, nhưng nay chỉ là **lớp bảo vệ thứ hai** cho cổng gõ nhầm (3000 / 5173 / 8000).

## Chạy nhanh

Cách an toàn nhất — hộp cát tự dựng máy chủ trên cổng trống trong dải 39000–39999 với một
`DATA_DIR` tạm, rồi tự dọn:

```bash
node scripts/sim/sandbox.js --server-entry apps/server/src/index.js            # cả 6 kịch bản
node scripts/sim/sandbox.js --server-entry apps/server/src/index.js --scenario normal-10-devices
node scripts/sim/sandbox.js --server-entry apps/server/src/index.js --recognition-mode async
```

Hoặc tự dựng máy chủ rồi trỏ `--base` vào đó (chọn một cổng trong 39000–39999 mà **chưa ai
dùng** — `ss -ltn` để xem trước):

```bash
D=$(mktemp -d); PORT=39501          # thư mục tạm RIÊNG, cổng riêng
PORT=$PORT HOST=127.0.0.1 DATA_DIR="$D" SIM_OVERRIDE=true \
  RECOGNITION_PROVIDER=mock node apps/server/src/index.js & BEPID=$!

node scripts/sim/run-scenario.js normal-10-devices --base "http://127.0.0.1:$PORT"
node scripts/sim/virtual-devices.js --base "http://127.0.0.1:$PORT" --devices 3 --rate 12 --duration 20

ps -o cmd= -p "$BEPID"     # ĐỐI CHIẾU trước khi gửi tín hiệu
kill -INT "$BEPID"         # CHỈ giết PID mình vừa lưu
rm -rf "$D"
```

**Không bao giờ** trỏ `--base` vào cổng 3000/5173/8000 và không bao giờ dùng `DATA_DIR` thật:
kịch bản `backend-down-30s` sẽ làm máy chủ đó ngừng phục vụ trong 30 giây.

Test: `npm run test:sim` (hoặc `node --test "scripts/sim/test/**/*.test.js"`).

## Kịch bản đòi cấu hình máy chủ riêng (`serverEnv`)

Một kịch bản có thể khai trong file JSON của nó:

```json
"serverEnv": { "RECOGNITION_MODE": "async", "RECOGNITION_MAX_CONCURRENT": "2" }
```

* `sandbox.js` gom kịch bản theo cấu hình. Khi cấu hình đổi, nó **dừng** máy chủ cũ (đối chiếu
  `/proc/<pid>/cmdline` như mọi khi), xoá `DATA_DIR` của nó, rồi dựng máy chủ mới trên cổng mới.
  Không bao giờ có hai máy chủ cùng sống. `serverEnv` **thắng** `--env` và `--recognition-mode`.
* `run-scenario.js` **đối chiếu lại** ở pha tiền kiểm: chạy một kịch bản `async` vào máy chủ
  `sync` thì nó thoát 2 kèm lời chỉ dẫn, thay vì chạy 66 giây rồi mới đỏ.

## Mã thoát

| | `run-scenario.js` | `virtual-devices.js` |
|---|---|---|
| 0 | ĐẠT, hoặc SKIPPED vì endpoint chưa có | không có `otherError` |
| 1 | KHÔNG ĐẠT | có `otherError` |
| 2 | sai tham số / kịch bản hỏng / không chạy được | sai tham số |
| 130 | bị Ctrl+C (đã kết phiên, đã xoá kịch bản, đã in báo cáo) | như bên trái |

## An toàn — luật của thư mục này

* `run-scenario.js` và `virtual-devices.js` **không khởi động và không dừng tiến trình nào.**
  "Máy chủ ngừng hoạt động" diễn bằng `sim.set {"backend":{"mode":"down"}}`, không bằng `kill`.
* `sandbox.js` là nơi duy nhất khởi động tiến trình, qua `lib/proc.js`. Nó chỉ dừng đúng tiến
  trình do chính nó spawn, và **chỉ sau khi đối chiếu `/proc/<pid>/cmdline`** với dòng lệnh ghi
  lúc spawn. Lệch → từ chối gửi tín hiệu (có test khoá hành vi này).
* Không lấy PID từ bảng tiến trình hay bộ dò cổng. Không có giết hàng loạt.
* Mọi lời gọi HTTP có timeout. Dọn dẹp nằm trong `finally`: hỏng giữa chừng vẫn không để lại
  phiên mở hay kịch bản mô phỏng còn bật.

## Kịch bản tự chấm như thế nào

Mỗi kịch bản khai báo `expect` — danh sách kỳ vọng **đo được**. Bộ chạy chụp số liệu trước và
sau, so với ngưỡng, rồi kết luận ĐẠT/KHÔNG ĐẠT kèm số đo. Ba luật:

1. **Mỗi số đo một nguồn duy nhất.** `receipts.*`, `outbox.*`, `status.*`, `events.count`,
   `recognitions.*` đọc từ **máy chủ**; `counter.*`, `save.*`, `recognize.*`, `requestId.unique`
   do **đội thiết bị** tự đo. Không bao giờ lấy `receipts.delta` từ bộ đếm client — chênh lệch
   giữa hai con số chính là thứ ta đi tìm.
   `recognitions.delta` / `recognitions.byStatus` / `recognitions.pendingEnd` đọc từ
   `GET /api/admin/recognitions` (`counts` đếm **toàn bảng**); `status.recognitionMode` đọc từ
   `GET /api/status`. Endpoint vắng mặt → số đo là **null ⇒ kỳ vọng đỏ**, không quy về 0.
2. **Delta, không phải trị tuyệt đối.** DB thử nghiệm luôn có dữ liệu cũ.
3. **Kỳ vọng phải có thể đỏ.** `expect` rỗng → thoát 2. `check` gõ sai → ném ngay lúc nạp.
   Kỳ vọng kiểu `receipts.delta >= 0` bị test chặn vì nó luôn đúng.

Mỗi kịch bản có một kỳ vọng **canary** sẽ đỏ khi tính năng đang kiểm bị gỡ:

| Kịch bản | Canary |
|---|---|
| `normal-10-devices` | `receipts.delta >= 50` |
| `ocr-slow-then-recover` | `events.count recognition.failed >= 1` |
| `backend-down-30s` | `counter.blocked >= 5` |
| `sap-down-then-recover` | `events.count receipt.post_retry >= 1` |
| `overload-20-uploads` | `counter.busy429 >= 1` |
| `async-recognition-no-stuck-jobs` | `recognitions.pendingEnd == 0` |

## Hai chỗ dễ nhầm

* **`body.requestId` ≠ header `x-request-id`.** `body.requestId` sinh một lần cho mỗi phiếu và
  **dùng lại y nguyên khi thử lại** (khoá idempotency của BE). Header `x-request-id` mới mỗi
  attempt (chỉ để truy vết). Ngoại lệ duy nhất được đổi `requestId`: nhánh `409 DUPLICATE_LABEL`.
* **`--seed` làm dữ liệu phiếu tất định, nhưng `requestId` thì không.** Nếu `requestId` cũng tất
  định thì lần chạy thứ hai cùng seed sẽ rơi vào nhánh idempotency và `receipts.delta` bằng 0.
  Hệ quả: chạy lại cùng seed trên **cùng DB trong cùng ngày** sẽ gặp `409 DUPLICATE_LABEL` — thiết
  bị ảo tự gửi lại với `allowDuplicate: true`, nên phiếu vẫn được lưu và `counter.duplicate` tăng.

## Quyết định đã chốt

| # | Vấn đề | Chốt |
|---|---|---|
| V-A | `504 RECOGNITION_TIMEOUT` nên vào bộ đếm nào? | bộ đếm riêng `recognizeFailed`, không nhập vào `otherError` — `otherError` phải giữ nghĩa "chuyện không nằm trong kịch bản nào cả" |
| V-B | `uploads.burst` chặn hay không chặn? | **không chặn** — kịch bản quá tải còn phải chấm đỉnh hàng đợi trong lúc burst chạy |
| V-C | `sap-down-then-recover` dùng `settleMs` bao nhiêu? | **75000**, không phải 30000 (xem dưới) |
| V-D | Thứ tự dọn dẹp | xoá kịch bản mô phỏng **trước**, dừng thiết bị **sau** — ngược lại thì `POST /api/sessions/:id/end` ăn 503 của chính kịch bản đang dọn |
| V-E | `--base` mặc định | **bỏ hẳn**. Mặc định nằm trong dải mô phỏng nên rào chắn cổng im lặng; bắt nói rõ ý định rẻ hơn một lần hạ nhầm máy chủ 30 giây |
| V-F | Chứng minh đã đi đường async | hai bộ đếm riêng `recognizeAccepted202` + `recognizePolls`. `recognizeOk` giống hệt nhau ở cả hai chế độ nên **không** dùng làm bằng chứng được |
| V-G | `recognitions.pendingEnd` lấy trị tuyệt đối hay delta? | **tuyệt đối** (như `outbox.pendingEnd`). Một dòng treo có từ trước vẫn là một PDA đang đứng ở «Đang đọc nhãn…»; lấy hiệu sẽ giấu mất nó |

**Về V-C:** thang backoff của outbox là 5 s / 15 s / 60 s / 60 s, và đồng hồ backoff đếm từ lần
thử **thất bại**, không phải từ lúc SAP lành. Phiếu tạo lúc `T` thử lại ở `T+5` và `T+20`; cả ba
lần đều rơi vào lúc SAP còn `down`, nên lần thứ tư bị hẹn tới `T+80`. Với `settleMs: 30000` thì
ảnh chụp cuối lấy ở giây 70 — sớm hơn lần thử thứ tư. Đo thật: 12 phiếu đều kẹt ở `posting`,
`outboxPending = 12`. Với `settleMs: 75000` (ảnh chụp ở giây 115): 12 phiếu `posted`,
`outboxPending = 0`. **Các ngưỡng chấm điểm không đổi**, chỉ đổi thời gian chờ để phép đo diễn ra
sau khi hệ thống đã có đủ cơ hội tự lành đúng như ý đồ của kịch bản.

## Về `async-recognition-no-stuck-jobs`

Kịch bản duy nhất chạy `RECOGNITION_MODE=async`. Nó phải khẳng định được **hai** điều, và mỗi
điều cần một phép đo riêng:

| Điều cần khẳng định | Kỳ vọng |
|---|---|
| (a) mọi dòng nhận dạng kết thúc dứt khoát, không dòng nào treo | `recognitions.pendingEnd == 0`, kèm `recognitions.byStatus failed >= 1` để chắc nhánh "chờ quá hạn" thật sự được đi qua chứ không phải vắng mặt |
| (b) đường 202 + thăm dò được đi thật, không âm thầm rơi về sync | `status.recognitionMode == async` (cấu hình) **và** `counter.recognizeAccepted202 >= 12` + `counter.recognizePolls >= 12` (đã đi qua thật) |

Hai giai đoạn: 25 s chạy bình thường để đường 202 hoàn tất, rồi OCR chậm 6 s + 14 upload đồng
thời vào giới hạn `MAX_CONCURRENT=2` / `MAX_WAITING=12` / `MAX_WAIT_MS=3000` — đủ để có cả lượt
**chờ quá hạn**, đúng nhánh từng để lại dòng `pending` vĩnh viễn.

`queue.peakInflight <= 2` là rào chắn cho lỗi ngược lại: nhả một slot chưa từng chiếm sẽ làm
số job chạy đồng thời vượt trần.
