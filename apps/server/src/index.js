import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { logger } from "./log.js";

const config = loadConfig();
const app = buildApp(config, { logger });

app.server.listen(config.port, config.host, () => {
  logger.info("server.listening", {
    url: `http://${config.host}:${config.port}`,
    provider: config.provider,
    mockMode: config.mock.mode,
    simOverride: config.simOverride,
    requireDeviceId: config.requireDeviceId,
    sapAdapter: config.sap.adapter,
    outboxEnabled: config.outbox.enabled,
    outboxTickMs: config.outbox.tickMs,
    ruleDuplicate: config.rules.duplicate,
    ruleLocation: config.rules.location,
    recognitionTimeoutMs: config.recognitionTimeoutMs,
    recognitionMaxAttempts: config.recognitionMaxAttempts,
    recognitionMaxConcurrent: config.recognitionMaxConcurrent,
    recognitionMaxWaiting: config.recognitionMaxWaiting,
    dbPath: config.dbPath,
    uploadsDir: config.uploadsDir,
    maxUploadBytes: config.maxUploadBytes,
  });
  /* R2: chuỗi timeout phải giảm dần webapp > BE > ai-server. Hỏi /health của ai-server
   * (trường upstreamTimeoutMs) rồi cảnh báo nếu cấu hình đang vi phạm — không chặn khởi động. */
  app.status.checkTimeoutChain().catch((err) => logger.warn("config.timeout_chain_check_failed", { error: err?.message }));
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info("server.shutdown", { signal });
  /* Ghi dòng cuối cùng vào sổ sự kiện TRƯỚC khi đóng server: sau đó DB có thể đã đóng hoặc
   * hỏng. Bọc try/catch vì một dòng nhật ký quan sát không được làm hỏng việc tắt máy. */
  try {
    app.events.write({ type: "server.stop", detail: { signal, uptimeSec: Math.round(process.uptime()) } });
  } catch (err) {
    logger.warn("events.stop_failed", { error: err?.message });
  }
  const force = setTimeout(() => process.exit(1), 5000).unref();
  app.server.close(async () => {
    await app.close();
    clearTimeout(force);
    process.exit(0);
  });
  app.server.closeAllConnections?.();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
