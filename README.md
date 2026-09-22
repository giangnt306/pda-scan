# PDA Scan — bước 2

## Chạy

Monorepo npm workspaces, Node ≥ 22.13.

```text
apps/webapp     React + Vite (HTTPS :5173), proxy /api → BE
apps/server     Main Backend (loopback :3000), SQLite, gọi ai-server khi RECOGNITION_PROVIDER=http
apps/ai-server  OCR bằng LLM vision (loopback :8000)
scripts/        dev.js (chạy cả 3), sim/ (kịch bản giả lập thiết bị)
```

```bash
npm install
cp apps/ai-server/.env.example apps/ai-server/.env   # dán OPENAI_API_KEY, hoặc đặt OCR_SIM_MODE
cp apps/server/.env.example apps/server/.env         # RECOGNITION_PROVIDER=http để dùng ai-server
npm run dev      # ai-server + BE + webapp; WITHOUT_AI=1 để bỏ ai-server
npm test         # test ai-server, server, sim
```

Chụp nhãn xong, webapp POST ảnh lên `/api/recognitions` (BE); lỗi thì báo toast và người vận hành nhập tay.
Chi tiết: [apps/server/README.md](apps/server/README.md), [apps/ai-server/README.md](apps/ai-server/README.md), [scripts/sim/README.md](scripts/sim/README.md).

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
