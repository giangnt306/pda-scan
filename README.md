# PDA Scan — bước 2

## Chạy

```bash
npm install
npm run dev
```

Dev server giờ chạy **https://** (chứng chỉ tự ký). Terminal in ra hai dòng:

```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.1.xx:5173/
```

Mở dòng `Network` trên điện thoại (cùng WiFi). Chrome sẽ cảnh báo
"Your connection is not private" — bấm **Advanced → Proceed**. Sau khi
vượt qua, origin vẫn là secure context nên camera hoạt động bình thường.
Chỉ phải làm một lần cho mỗi thiết bị.

### Nếu không muốn bấm qua cảnh báo mỗi lần

Trên Chrome Android, mở `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
dán `http://192.168.1.xx:5173` vào ô, chọn **Enabled**, khởi động lại Chrome.
Lúc đó bỏ `basicSsl()` trong `vite.config.js` để quay về http thường.

Chỉ dùng cho máy dev. Khi deploy thật thì có HTTPS thật, không cần cờ này.

## Engine đọc mã vạch

| Nền tảng | Engine | Ghi chú |
|---|---|---|
| Chrome Android (PDA, phone) | `BarcodeDetector` có sẵn trong hệ điều hành | Nhanh, không tải thêm gì |
| Chrome Windows / Linux | ponyfill WebAssembly | Tự động nạp khi cần, ~43KB + file `.wasm` tải từ CDN |

Khi đang chạy ponyfill, dòng chữ dưới khung camera sẽ ghi
"đang dùng bộ giải mã dự phòng" — đó là dấu hiệu bạn đang test trên
laptop chứ không phải thiết bị thật.

Lưu ý: ponyfill tải file `.wasm` từ CDN jsDelivr, nên **cần internet**.
Máy Android không bị ảnh hưởng vì dùng engine hệ thống.

## Định dạng mã đang bật

QR, Code 128, Code 39, EAN-13, EAN-8, UPC-A, UPC-E, ITF, DataMatrix.

Sửa mảng `WANTED_FORMATS` trong `src/lib/barcode.js` nếu kho chỉ dùng
một vài loại — bật ít định dạng thì nhận dạng nhanh và ít nhầm hơn.

## Tài liệu

| File | Nội dung |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Cấu trúc module, luồng dữ liệu, các phần còn stub |
| [docs/data-model.md](docs/data-model.md) | Schema trường, chuẩn hoá, provenance, validation |
| [docs/development.md](docs/development.md) | Chạy dev, HTTPS, test trên máy thật, các lỗi camera |
| [docs/roadmap.md](docs/roadmap.md) | Việc còn lại và các quyết định đã hoãn |
