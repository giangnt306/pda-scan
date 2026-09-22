# PDA Scan — bước 2

## Chạy

```bash
npm install
npm run dev
```

## Chụp nhãn

Ảnh nhãn chỉ chụp bằng **ImageCapture API** (`takePhoto()`), ở độ phân giải
tối đa của cảm biến. Ứng dụng chưa có chức năng quét mã vạch — dữ liệu
lấy từ ảnh nhãn (nhận dạng) hoặc nhập tay.

## Tài liệu

| File                                          | Nội dung                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)   | Cấu trúc module, luồng dữ liệu, các phần còn stub                  |
| [docs/data-model.md](docs/data-model.md)       | Schema trường, chuẩn hoá, provenance, validation                       |
| [docs/image-capture.md](docs/image-capture.md) | Chụp nhãn bằng ImageCapture API, giữ ảnh gốc, bản thu nhỏ gửi OCR |
| [docs/development.md](docs/development.md)     | Chạy dev, HTTPS, test trên máy thật, các lỗi camera                  |
| [docs/roadmap.md](docs/roadmap.md)             | Việc còn lại và các quyết định đã hoãn                          |
