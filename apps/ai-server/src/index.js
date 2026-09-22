import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);
server.headersTimeout = 65_000;
server.requestTimeout = 120_000;
server.listen(config.port, config.host, () => {
  process.stdout.write(
    JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "ai-server.listening", url: `http://${config.host}:${config.port}`, model: config.model, baseUrl: config.baseUrl, configured: Boolean(config.apiKey), ready: Boolean(config.apiKey) || config.ocrSimMode !== "passthrough", simMode: config.ocrSimMode, upstreamTimeoutMs: config.upstreamTimeoutMs }) + "\n",
  );
  // Đang mô phỏng thì không cần key — đừng doạ người dùng bằng cảnh báo sai.
  if (config.ocrSimMode !== "passthrough") {
    process.stderr.write(`[ai-server] OCR_SIM_MODE=${config.ocrSimMode} — mô phỏng dịch vụ OCR hỏng, KHÔNG gọi OpenAI (không tốn quota).\n`);
  } else if (!config.apiKey) {
    process.stderr.write("[ai-server] Chưa có OPENAI_API_KEY — /recognize sẽ trả 503 NOT_CONFIGURED. Xem ai-server/.env.example\n");
  }
});
const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
