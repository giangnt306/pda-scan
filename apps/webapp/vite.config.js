import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// basicSsl() tạo chứng chỉ tự ký để dev server chạy https://
// Bắt buộc vì getUserMedia chỉ hoạt động trong secure context.
// /api proxy sang Main Backend (apps/server, loopback :3000): PDA chỉ cần một địa chỉ HTTPS,
// BE không cần bind ra LAN. BE mới gọi ai-server; webapp không biết ai-server tồn tại.
const API_TARGET = process.env.API_TARGET || "http://127.0.0.1:3000";
const proxy = { "/api": { target: API_TARGET, timeout: 120_000, proxyTimeout: 120_000 } };

export default defineConfig({
  plugins: [react(), basicSsl()],
  // strictPort: cổng bận thì báo lỗi, không lặng lẽ lùi sang 5174 trong khi PDA vẫn mở 5173.
  server: { host: true, port: 5173, strictPort: true, proxy },
  preview: { host: true, port: 4173, proxy },
});
