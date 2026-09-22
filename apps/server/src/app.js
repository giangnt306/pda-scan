import { openDb } from "./db.js";
import { createStorage } from "./storage.js";
import { createRecognitionService, selectProvider } from "./recognition/service.js";
import { createReceiptService } from "./receipts.js";
import { createDeviceService } from "./devices.js";
import { createSessionService } from "./sessions.js";
import { createSimEngine } from "./sim/engine.js";
import { wrapProviderWithSim, SLOW_MIN_MS } from "./sim/ocrWrapper.js";
import { createStatusService, readVersion } from "./status.js";
import { createLifecycle } from "./lifecycle.js";
import { createOutbox } from "./outbox.js";
import { createOutboxWorker } from "./outboxWorker.js";
import { selectSapAdapter } from "./sap/adapter.js";
import { createMasterService } from "./master.js";
import { createRules } from "./rules/index.js";
import { createApp } from "./http.js";
import { createEventLog } from "./events.js";
import { createAsyncJobs } from "./recognition/asyncJobs.js";

/* Tiến trình BE chết giữa lúc nhận dạng để lại dòng 'pending' treo vĩnh viễn. Dọn ngay lúc
 * khởi động: không có worker nào sẽ quay lại làm tiếp chúng. */
function sweepPending(db, logger) {
  const info = db
    .prepare(
      `UPDATE recognitions SET status='failed', error_code='INTERRUPTED',
              error_message='Tiến trình BE dừng giữa lúc nhận dạng', finished_at=?
        WHERE status='pending'`,
    )
    .run(new Date().toISOString());
  const count = Number(info.changes ?? 0);
  logger?.info("recognition.sweep", { count });
  // Trả về con số để đưa vào detail.sweptRecognitions của sự kiện server.start.
  return count;
}

/* Lắp ráp toàn bộ ứng dụng từ config. Dùng chung cho index.js và test. */
export function buildApp(config, { logger, provider, probeFetch, sapAdapter } = {}) {
  const db = openDb(config.dbPath, logger);
  const sweptRecognitions = sweepPending(db, logger);

  const storage = createStorage({ uploadsDir: config.uploadsDir, db });
  /* sessions dựng TRƯỚC devices: devices.list() cần sessions.get() để trả khối `session` rút
   * gọn của mỗi thiết bị cho màn hình giám sát. Không có phụ thuộc ngược lại. */
  const sessions = createSessionService({ db, logger });
  const devices = createDeviceService({ db, logger, sessions });
  const sim = createSimEngine({ db, config, logger });

  /* events phải có TRƯỚC lifecycle: lifecycle ghi gương receipt_events → system_events. */
  const events = createEventLog({ db, config, logger });
  const lifecycle = createLifecycle({ db, logger, events, config });
  const outbox = createOutbox({ db, config, logger });
  const master = createMasterService({ config, logger }); // STUB ở Stage 1, BE-2 hiện thực
  const rules = createRules({ db, config, master, logger }); // STUB ở Stage 1, BE-2 hiện thực

  /* Mode OCR do kịch bản quyết định, áp cho CẢ provider mock lẫn http; wrapper giữ nguyên
   * provider.name để /api/health và response nhận dạng không đổi.
   * slowMinMs: với provider mock lấy theo MOCK_SLOW_DELAY_MS (mặc định 6000 = SLOW_MIN_MS)
   * để cấu hình mock vẫn là một nguồn sự thật duy nhất cho "chậm". */
  const baseProvider = provider ?? selectProvider(config);
  const wrapped = wrapProviderWithSim(baseProvider, (args) => args?.options?.sim ?? { mode: "success", delayMs: 0 }, {
    slowMinMs: config.provider === "mock" ? (config.mock.slowDelayMs ?? SLOW_MIN_MS) : SLOW_MIN_MS,
  });

  const recognition = createRecognitionService({ db, storage, config, logger, provider: wrapped, events });
  const receipts = createReceiptService({ db, config, logger, lifecycle, outbox, rules, sessions });
  const status = createStatusService({
    config,
    recognition,
    sim,
    outbox,
    logger,
    ...(probeFetch ? { fetchImpl: probeFetch } : {}),
  });

  /* sapAdapter tiêm được từ test (L13), giống cách provider/probeFetch đã làm ở Phase 3.
   * selectSapAdapter trả null khi SAP_ADAPTER=none → worker.start() không làm gì. */
  const sap = sapAdapter ?? selectSapAdapter({ config, sim, logger });
  const worker = createOutboxWorker({ db, config, outbox, lifecycle, receipts, sessions, sap, logger });
  worker.start();
  const revivedOutbox = worker.revivedOnBoot;

  /* Sổ theo dõi job nhận dạng nền; rỗng hoàn toàn ở chế độ sync. */
  const asyncJobs = createAsyncJobs({ logger });

  const server = createApp({
    config,
    db,
    storage,
    recognition,
    receipts,
    devices,
    sessions,
    status,
    sim,
    lifecycle,
    outbox,
    master,
    rules,
    events,
    asyncJobs,
    logger,
  });

  /* Dòng đầu tiên của sổ sự kiện, ghi SAU CÙNG khi mọi thứ đã lắp xong: nó khẳng định
   * "từ giây này trở đi mọi thứ dưới đây là thật". */
  events.write({
    type: "server.start",
    detail: {
      version: readVersion(),
      provider: recognition.provider.name,
      recognitionMode: config.recognitionMode,
      sweptRecognitions,
      revivedOutbox,
    },
  });

  return {
    db,
    storage,
    recognition,
    receipts,
    devices,
    sessions,
    sim,
    status,
    lifecycle,
    outbox,
    master,
    rules,
    sap,
    worker,
    events,
    asyncJobs,
    server,
    /* close() là ASYNC (đổi so với Phase 4) và MỌI nơi gọi phải `await`.
     * Lý do chọn phương án async thay vì hoãn db.close() bằng queueMicrotask: một job nhận dạng
     * nền có thể còn đang chờ provider hàng giây, microtask không đợi được nó, và khi nó quay
     * lại thì prepare() trên DB đã đóng sẽ ném ERR_SQLITE ra ngoài mọi try/catch, làm đỏ những
     * test chẳng liên quan gì (cạm bẫy L12 của Phase 4). drain() chờ có trần nên không treo.
     * Thứ tự bắt buộc: drain job nền → worker.stop() → db.close(). */
    close: async () => {
      /* Không có job nền nào (chế độ sync — mặc định) thì KHÔNG await gì cả: thân hàm async
       * chạy đồng bộ tới `await` đầu tiên, nên db đóng ngay trong cùng tick, đúng như Phase 4. */
      if (asyncJobs.size() > 0) await asyncJobs.drain(5000);
      worker.stop();
      db.close();
    },
  };
}
