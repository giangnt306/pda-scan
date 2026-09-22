# Hợp đồng máy đọc được (`docs/contracts/`)

Thư mục này chứa các hợp đồng **máy đọc được** — thứ mà test tự động kiểm tra được, khác với tài liệu
mô tả bằng văn xuôi. Nguồn sự thật bằng văn bản vẫn là `docs/specs/phase-3/01-contracts.md`; các file ở
đây là bản dịch sang định dạng máy kiểm.

| File | Mô tả | Ai phải tuân thủ | Ai kiểm |
|---|---|---|---|
| `ocr-response.schema.json` | JSON Schema draft-07 cho response `200` của `POST /recognize` (ai-server) | `apps/ai-server/src/ocr.js` + `src/server.js` (bên sinh), `apps/server/src/recognition/providers/http.js` → `mapAiResponse` (bên đọc) | `apps/server/test/contract.test.js` |
| `sap-adapter.md` | Interface `postGoodsReceipt` — **đã hiện thực ở Phase 4** trong `apps/server/src/sap/adapter.js` + `sap/mock.js` | `apps/server/src/sap/`, `outboxWorker.js` | `apps/server/test/sap.test.js`, `test/outbox.test.js` |
| `../openapi.yaml` | OpenAPI 3.1 của Main Backend — nằm ở `docs/`, không ở đây, vì nó là hợp đồng của cả API chứ không riêng một cạnh | `apps/server/src/http.js`, `src/routes/master.js`, `src/routes/rules.js`, `src/routes/admin.js` | `apps/server/test/contract.test.js` (cú pháp YAML + route hai chiều + schema ↔ response thật) |

> **Ràng buộc hai chiều đang được khoá bằng test:** số operation **không** mang `x-status: planned`
> phải bằng **đúng** số route thật trong `apps/server/src` — không còn chênh lệch nào. Operation duy
> nhất được phép `planned` là `GET /api/events` (SSE, hoãn sang Phase 6). Thêm một route mà quên
> khai vào `openapi.yaml`, hoặc khai một operation mà quên hiện thực, đều làm test đỏ.

## Đổi một hợp đồng thì phải sửa những gì

**`ocr-response.schema.json`**

1. Sửa `docs/specs/phase-3/01-contracts.md` trước — spec là nguồn sự thật, schema chỉ dịch lại.
   (Trong Phase 3, `docs/specs/**` là **bất biến**; đổi spec là việc của Phase sau.)
2. Sửa `FIELD_SPECS` trong `apps/ai-server/src/ocr.js` nếu đổi danh sách 10 tên trường.
3. Sửa `NAME_MAP` trong `apps/server/src/recognition/providers/http.js` để ánh xạ tên mới về key form.
4. Sửa `FIELDS` trong `apps/server/src/fields.js` nếu thêm key form mới.
5. Chạy `npm run test:server` — `contract.test.js` khoá cả ba chỗ trên lại với nhau: test 5 khẳng định
   `enum` trong schema **khớp từng phần tử, đúng thứ tự** với `FIELD_SPECS`.

## Quy tắc chặt/lỏng của `ocr-response.schema.json`

- `additionalProperties: true` ở **cấp gốc** — ai-server được thêm field mới (`simMode`, `retryCount`…)
  mà không làm gãy Main Backend.
- `additionalProperties: false` **bên trong `fields[]`** — đây là phần Main Backend ánh xạ trực tiếp,
  một key lạ ở đây nghĩa là hai bên đã hiểu khác nhau, phải fail ngay.
- `minItems: 10` / `maxItems: 10` — ai-server **luôn** liệt kê đủ 10 trường; ô trống trên nhãn là
  `text: null, score: 0`, **không phải** bỏ phần tử. Mọi `OCR_SIM_MODE` trả HTTP 200 cũng phải giữ đủ 10.
- `score` là `0..1`. Model tự báo `score > 1` (thang 0–100) đã được `normalizeModelOutput` chia 100 trước.

## Ghi chú về mock provider

`apps/server/src/recognition/providers/mock.js` chỉ trả **8** trường (thiếu `plant_dock`, `batch`) nên
**không** khớp schema gốc. Đây là chủ ý: schema mô tả contract của **ai-server**, không phải của mock.
`contract.test.js` kiểm mock bằng một biến thể nới `minItems` và khẳng định rõ rằng schema gốc **từ chối**
mock — nếu một ngày mock được sửa cho đủ 10 trường, test đó sẽ đỏ và người sửa phải cập nhật có ý thức.

## Validator

Không có dependency JSON Schema nào trong repo (nguyên tắc R1 của Phase 3: zero runtime dependency cho
`apps/server` và `apps/ai-server`). Validator draft-07 **rút gọn** được tự viết ngay trong
`apps/server/test/contract.test.js`; nó hỗ trợ `type` (kể cả mảng type), `required`, `properties`,
`additionalProperties`, `items`, `minItems`/`maxItems`, `enum`, `minimum`/`maximum`, `pattern`, và **bỏ qua
im lặng** `$ref`, `oneOf`/`anyOf`/`allOf`, `format`, `patternProperties`, `const`, `multipleOf`,
`uniqueItems`, `items` dạng tuple. Đừng dùng nó như validator đa dụng; khi viết schema mới trong thư mục
này, hãy giới hạn trong các từ khoá được hỗ trợ.
