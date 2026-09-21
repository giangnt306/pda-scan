import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// basicSsl() tạo chứng chỉ tự ký để dev server chạy https://
// Bắt buộc vì getUserMedia chỉ hoạt động trong secure context.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true, port: 5173 },
});
