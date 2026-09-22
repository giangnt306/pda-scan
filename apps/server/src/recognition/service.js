import crypto from "node:crypto";
import { normalizeRecognitionFields } from "../fields.js";
import { createMockProvider } from "./providers/mock.js";
import { createHttpProvider } from "./providers/http.js";
import { createSemaphore, RecognitionBusyError } from "./semaphore.js";

/* Service nhận dạng: sở hữu recognitionId, ảnh và trạng thái.
 * Phase 1: đồng bộ request/response với timeout.
 * Phase 5: thêm chế độ BẤT ĐỒNG BỘ — trả 202 ngay, job chạy nền, PDA poll kết quả. Hai chế độ
 * dùng CHUNG một hàm executeJob(): hai bản sao logic sẽ lệch nhau ở lần sửa thứ ba. */

export { RecognitionBusyError };

export const NO_FIELDS_WARNING = "Không đọc được trường nào trên nhãn";

/* Cửa sổ cố định 5 phút cho queue.recognitionsFailedRecent của GET /api/status (§2.1). */
export const FAILED_RECENT_WINDOW_MS = 300_000;

/** Độ dài tối đa của header x-capture-ref; dài hơn thì CẮT, không báo lỗi. */
export const CAPTURE_REF_MAX = 64;

export class RecognitionError extends Error {
  constructor(code, message, { recognitionId, imageId, cause } = {}) {
    super(message);
    this.code = code;
    this.recognitionId = recognitionId;
    this.imageId = imageId;
    this.cause = cause;
  }
}

export function selectProvider(config) {
  if (config.provider === "http") {
    return createHttpProvider({
      url: config.ai.url,
      apiKey: config.ai.apiKey,
      maxAttempts: config.recognitionMaxAttempts,
      backoffMs: config.recognitionRetryBackoffMs,
    });
  }
  return createMockProvider(config.mock);
}

const countOk = (fields) => Object.values(fields || {}).filter((f) => f?.status === "ok").length;

export function createRecognitionService({ db, storage, config, provider = selectProvider(config), logger, events = null }) {
  /* mode/capture_ref nằm ngay trong INSERT chứ không UPDATE thêm một lần sau đó: dòng
   * recognitions không bao giờ tồn tại ở trạng thái "đã pending nhưng chưa biết chế độ", nên
   * GET /api/admin/recognitions đọc giữa chừng cũng không thấy dữ liệu nửa vời. */
  const insert = db.prepare(
    `INSERT INTO recognitions (id, image_id, provider, status, created_at, device_id, session_id, request_id, mode, capture_ref)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  );
  const complete = db.prepare(
    "UPDATE recognitions SET status='completed', raw_result=?, normalized=?, duration_ms=?, finished_at=? WHERE id=?",
  );
  const fail = db.prepare(
    "UPDATE recognitions SET status='failed', error_code=?, error_message=?, duration_ms=?, finished_at=? WHERE id=?",
  );
  /* Chỉ dành cho thất bại XẢY RA TRƯỚC khi executeJob chạy (xem failWithoutRunning).
   * `AND status='pending'` là rào chắn: không bao giờ ghi đè một kết quả đã kết thúc. */
  const failIfPending = db.prepare(
    "UPDATE recognitions SET status='failed', error_code=?, error_message=?, duration_ms=?, finished_at=? WHERE id=? AND status='pending'",
  );
  const selectOne = db.prepare("SELECT * FROM recognitions WHERE id = ?");
  const countPending = db.prepare("SELECT COUNT(*) AS n FROM recognitions WHERE status='pending'");
  const countFailedSince = db.prepare(
    "SELECT COUNT(*) AS n FROM recognitions WHERE status='failed' AND finished_at >= ?",
  );
  const countByStatus = db.prepare("SELECT status, COUNT(*) AS n FROM recognitions GROUP BY status");
  const selectAdminAll = db.prepare("SELECT * FROM recognitions ORDER BY created_at DESC, rowid DESC LIMIT ?");
  const selectAdminByStatus = db.prepare(
    "SELECT * FROM recognitions WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  );

  const semaphore = createSemaphore({
    maxConcurrent: config.recognitionMaxConcurrent ?? 3,
    maxWaiting: config.recognitionMaxWaiting ?? 10,
    maxWaitMs: config.recognitionMaxWaitMs ?? 30000,
    retryAfterMs: config.recognitionBusyRetryAfterMs ?? 3000,
  });

  /* Sổ sự kiện không bao giờ được làm chết một lần nhận dạng: events.write đã nuốt lỗi DB,
   * lớp này chỉ nuốt nốt lỗi "type lạ" trong trường hợp bảng đăng ký bị sửa sai. */
  function emit(event) {
    if (!events) return;
    try {
      events.write(event);
    } catch (err) {
      logger?.warn("events.emit_failed", { type: event?.type, error: err?.message });
    }
  }

  function toPublic(row, imageMeta) {
    const normalized = row.normalized ? JSON.parse(row.normalized) : null;
    return {
      recognitionId: row.id,
      status: row.status,
      provider: row.provider,
      // Bản ghi cũ (Phase 1) chưa có fieldsFound trong normalized → tính lại từ fields.
      fieldsFound: normalized ? (normalized.fieldsFound ?? countOk(normalized.fields)) : 0,
      fields: normalized?.fields ?? null,
      warnings: normalized?.warnings ?? [],
      error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
      image: imageMeta
        ? { id: imageMeta.id, url: storage.relativeUrl(imageMeta.id), mimeType: imageMeta.mimeType, bytes: imageMeta.bytes }
        : { id: row.image_id, url: storage.relativeUrl(row.image_id) },
      durationMs: row.duration_ms,
      requestId: row.request_id ?? null,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  /**
   * Gọi provider, chuẩn hoá kết quả, ghi completed/failed, bắn sự kiện.
   * Dùng CHUNG cho run() (sync) và runAsync() (nền) — không sao chép logic hai lần.
   *
   * NGÂN SÁCH TIMEOUT bắt đầu tính TỪ ĐÂY, tức là sau khi đã có slot: thời gian xếp hàng
   * không ăn vào RECOGNITION_TIMEOUT_MS (R6-2).
   *
   * @throws {RecognitionError} mọi trường hợp thất bại (đã ghi DB và đã bắn sự kiện)
   */
  async function executeJob({ recognitionId, image, options = {}, simOcr = null, requestId = null, deviceId = null, sessionId = null, clientSignal = null }) {
    const startedAt = Date.now();
    /* Một ngân sách duy nhất cho CẢ hai attempt (Q10): attempt 1 timeout thì không còn
     * thời gian để retry, tổng thời gian chờ của PDA không bao giờ gấp đôi. */
    const timeoutSignal = AbortSignal.timeout(config.recognitionTimeoutMs);
    /* Hai lý do dừng: hết ngân sách của ta, hoặc client đã bỏ đi. Gộp lại một signal để
     * provider (và mọi sleep của wrapper sim) nhả slot ngay trong cả hai trường hợp.
     * Ở chế độ async, clientSignal LUÔN null (R6-1): client bỏ đi không được huỷ job. */
    const signal = clientSignal ? AbortSignal.any([timeoutSignal, clientSignal]) : timeoutSignal;
    const deadlineAt = Date.now() + config.recognitionTimeoutMs;
    try {
      const result = await provider.recognize({
        recognitionId,
        image: {
          id: image.id,
          mimeType: image.mimeType,
          bytes: image.bytes,
          getBuffer: () => storage.getBuffer(image.id),
          publicUrl: storage.publicUrl(image.id, config.ai.publicBaseUrl),
        },
        options: { ...options, ...(simOcr ? { sim: simOcr } : {}) },
        signal,
        requestId,
        deadlineAt,
      });
      const normalized = normalizeRecognitionFields(result.fields);
      normalized.fieldsFound = countOk(normalized.fields);
      if (normalized.fieldsFound === 0) normalized.warnings.push(NO_FIELDS_WARNING);
      const durationMs = Date.now() - startedAt;
      complete.run(JSON.stringify(result.raw ?? null), JSON.stringify(normalized), durationMs, new Date().toISOString(), recognitionId);
      logger?.info("recognition.completed", {
        recognitionId,
        durationMs,
        fieldsFound: normalized.fieldsFound,
        warnings: normalized.warnings.length,
        requestId,
      });
      emit({
        type: "recognition.completed",
        recognitionId,
        deviceId,
        sessionId,
        detail: { durationMs, fieldsFound: normalized.fieldsFound, warnings: normalized.warnings.length },
      });
      return toPublic(selectOne.get(recognitionId), image);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      /* Phân biệt theo ĐÚNG signal nào bắn: hết ngân sách của ta là RECOGNITION_TIMEOUT,
       * còn client bỏ đi thì không phải lỗi nhận dạng — đừng ghi nhầm vào sổ. */
      const timedOut = timeoutSignal.aborted || err?.name === "TimeoutError" || (!clientSignal?.aborted && err?.name === "AbortError");
      const clientLeft = !timeoutSignal.aborted && Boolean(clientSignal?.aborted);
      // Upstream hết giờ cũng là timeout với PDA — trả 504, không phải 502 (§9.3).
      const upstreamTimeout = err?.code === "UPSTREAM_TIMEOUT";
      const code = clientLeft
        ? "CLIENT_ABORTED"
        : timedOut || upstreamTimeout
          ? "RECOGNITION_TIMEOUT"
          : err?.code === "PROVIDER_NOT_CONFIGURED"
            ? "PROVIDER_NOT_CONFIGURED"
            : "RECOGNITION_FAILED";
      const message = clientLeft
        ? "Client ngắt kết nối trước khi nhận dạng xong"
        : timedOut
          ? `Nhận dạng quá ${config.recognitionTimeoutMs} ms không phản hồi`
          : err?.message || "Nhận dạng thất bại";
      fail.run(code, message, durationMs, new Date().toISOString(), recognitionId);
      logger?.warn("recognition.failed", { recognitionId, code, durationMs, provider: provider.name, requestId });
      emit({ type: "recognition.failed", recognitionId, deviceId, sessionId, detail: { durationMs, code } });
      throw new RecognitionError(code, message, { recognitionId, imageId: image.id, cause: err });
    }
  }

  /**
   * Kết thúc một lượt nhận dạng CHƯA BAO GIỜ CHẠY: dòng `recognitions` đã được tạo ở trạng thái
   * `pending`, nhưng job nền không xin được slot (chờ quá RECOGNITION_MAX_WAIT_MS) nên
   * executeJob — nơi duy nhất còn lại biết ghi `failed` — không hề chạy.
   *
   * Không có hàm này thì dòng đó nằm `pending` vĩnh viễn: PDA poll mãi, S9 đếm mãi một job
   * "đang chạy" không tồn tại, và `recognitions.pending` không bao giờ về 0.
   *
   * `duration_ms` = thời gian NẰM HÀNG ĐỢI (đó là toàn bộ thời gian máy chủ tiêu cho lượt này),
   * `error_message` nói rõ đã chờ bao lâu để không ai đọc nhầm thành "OCR chạy quá lâu".
   */
  function failWithoutRunning({ recognitionId, err, queuedAt, deviceId, sessionId, requestId }) {
    const busy = err?.code === "RECOGNITION_BUSY";
    const code = busy ? "RECOGNITION_BUSY" : "RECOGNITION_FAILED";
    const durationMs = Math.max(0, Date.now() - queuedAt);
    const message = busy
      ? `Chờ ${durationMs} ms trong hàng đợi nhận dạng mà chưa tới lượt (trần ${config.recognitionMaxWaitMs ?? 30000} ms)`
      : err?.message || "Nhận dạng thất bại trước khi kịp chạy";
    try {
      /* DB có thể đã đóng nếu tiến trình đang tắt: đó là lý do có try/catch, KHÔNG phải để
       * nuốt lỗi lập trình — lỗi vẫn được ghi ra log ở mức error. */
      if (failIfPending.run(code, message, durationMs, new Date().toISOString(), recognitionId).changes === 0) return;
    } catch (dbErr) {
      logger?.error("recognition.fail_write_failed", { recognitionId, code, error: dbErr?.message });
      return;
    }
    logger?.warn("recognition.failed", { recognitionId, code, durationMs, provider: provider.name, requestId });
    /* Cùng loại sự kiện và cùng hình dạng `detail` như thất bại của executeJob: màn hình giám
     * sát không cần biết job hỏng ở trước hay sau khi có slot (R6-5). */
    emit({ type: "recognition.failed", recognitionId, deviceId, sessionId, detail: { durationMs, code } });
  }

  /* Tạo dòng recognitions + bắn recognition.started. Dùng chung cho hai chế độ để cột `mode`
   * và sự kiện luôn được ghi ở CẢ HAI (R6-5: monitor không được phân biệt hai chế độ). */
  function createRow({ image, mode, deviceId, sessionId, requestId, captureRef, simOcr, options }) {
    const recognitionId = crypto.randomUUID();
    insert.run(
      recognitionId,
      image.id,
      provider.name,
      new Date().toISOString(),
      deviceId,
      sessionId,
      requestId,
      mode,
      captureRef ?? null,
    );
    logger?.info("recognition.start", {
      recognitionId,
      imageId: image.id,
      bytes: image.bytes,
      provider: provider.name,
      mode: simOcr?.mode ?? options?.mode,
      recognitionMode: mode,
      requestId,
      deviceId,
      sessionId,
    });
    emit({
      type: "recognition.started",
      recognitionId,
      deviceId,
      sessionId,
      detail: { mode, provider: provider.name, bytes: image.bytes },
    });
    return recognitionId;
  }

  return {
    provider,
    stats: () => semaphore.stats(),
    canAdmit: () => semaphore.canAdmit(),

    /* ĐỒNG BỘ — hành vi, chữ ký và mã lỗi GIỮ NGUYÊN như Phase 1-4.
     * Xin slot → lưu ảnh → tạo recognition → gọi provider (ngân sách timeout chung) → lưu kết quả. */
    async run({ imageBuffer, options = {}, deviceId = null, sessionId = null, requestId = null, simOcr = null, clientSignal = null, captureRef = null } = {}) {
      /* clientSignal abort khi PDA ngắt kết nối: rời hàng đợi ngay thay vì chiếm chỗ vô ích.
       *
       * `await` này nằm NGOÀI try một cách có chủ ý: acquire() bị từ chối (429, hoặc client bỏ
       * đi lúc đang xếp hàng) thì `finally` bên dưới KHÔNG chạy, nên không có release() nào nhả
       * một slot chưa từng được chiếm. Chuyển dòng này vào trong try là tái tạo đúng lỗi vượt
       * trần đồng thời mà runAsync đã mắc. */
      await semaphore.acquire(clientSignal);
      try {
        const image = await storage.saveImage(imageBuffer);
        const recognitionId = createRow({
          image,
          mode: "sync",
          deviceId,
          sessionId,
          requestId,
          captureRef,
          simOcr,
          options,
        });
        return await executeJob({ recognitionId, image, options, simOcr, requestId, deviceId, sessionId, clientSignal });
      } finally {
        /* Phải nằm trong finally: quên release một lần là hàng đợi kẹt vĩnh viễn. Không cần cờ
         * `held` như runAsync vì tới được đây nghĩa là acquire() ở trên ĐÃ resolve. */
        semaphore.release();
      }
    },

    /**
     * BẤT ĐỒNG BỘ. Trả NGAY sau khi tạo dòng `pending`; job chạy nền.
     * @returns {{ public: object, jobPromise: Promise<void> }}
     * @throws {RecognitionBusyError} hàng đợi đã đầy → 429, KHÔNG để lại ảnh và dòng DB nào
     */
    async runAsync({ imageBuffer, options = {}, deviceId = null, sessionId = null, requestId = null, simOcr = null, captureRef = null } = {}) {
      /* canAdmit() và acquire() phải ở CÙNG MỘT TICK và TRƯỚC saveImage (QUYẾT ĐỊNH A-5):
       * kiểm rồi `await saveImage()` rồi mới acquire thì 20 request đồng thời cùng thấy
       * "còn chỗ" và cùng được nhận — mất hoàn toàn ngữ nghĩa 429. */
      if (!semaphore.canAdmit()) {
        const { inflight, waiting } = semaphore.stats();
        throw new RecognitionBusyError({ retryAfterMs: config.recognitionBusyRetryAfterMs ?? 3000, inflight, waiting });
      }
      /* clientSignal = null: ở chế độ async client ĐÃ ĐI RỒI sau khi nhận 202 — job phải chạy
       * tiếp, đó là toàn bộ mục đích của chế độ này (R6-1). */
      const slot = semaphore.acquire(null);
      slot.catch(() => {}); // không để rejection lọt ra ngoài trước khi có ai await

      const image = await storage.saveImage(imageBuffer);
      const recognitionId = createRow({
        image,
        mode: "async",
        deviceId,
        sessionId,
        requestId,
        captureRef,
        simOcr,
        options,
      });

      const queuedAt = Date.now();
      const jobPromise = (async () => {
        /* `held` = "đã THỰC SỰ chiếm được slot". `await slot` có thể bị TỪ CHỐI (chờ quá
         * RECOGNITION_MAX_WAIT_MS), và khi đó request này chưa bao giờ làm `inflight` tăng.
         * Nhả một slot mình không giữ sẽ chuyển thẳng slot cho người kế trong hàng đợi trong
         * khi job đang chạy vẫn chạy ⇒ vượt RECOGNITION_MAX_CONCURRENT, và `inflight` của
         * GET /api/status báo thiếu. */
        let held = false;
        try {
          await slot;
          held = true;
          await executeJob({ recognitionId, image, options, simOcr, requestId, deviceId, sessionId, clientSignal: null });
        } catch (err) {
          /* Job nền không có ai để ném lỗi tới, nên nơi DUY NHẤT báo tin cho PDA là dòng
           * `recognitions` — PDA đọc nó bằng GET /api/recognitions/:id.
           *
           * Hai loại thất bại đi qua đây, và chúng KHÁC nhau ở chỗ ai đã ghi DB:
           *  - `held === true`: executeJob đã chạy và tự ghi status='failed' + error_code
           *    trước khi ném. Không ghi đè gì thêm.
           *  - `held === false`: `await slot` bị từ chối nên executeJob CHƯA hề chạy —
           *    KHÔNG ai ghi gì cả. Bỏ qua ở đây thì dòng đó nằm `pending` vĩnh viễn và PDA
           *    treo ở "Đang đọc nhãn…" tới hết trần 90 giây của client. */
          if (!held) failWithoutRunning({ recognitionId, err, queuedAt, deviceId, sessionId, requestId });
          logger?.warn("recognition.async_failed", { recognitionId, code: err?.code, error: err?.message, held });
        } finally {
          // R6-3: quên một lần là hàng đợi kẹt vĩnh viễn — nhưng CHỈ nhả slot mình đang giữ.
          if (held) semaphore.release();
        }
      })();

      return { public: toPublic(selectOne.get(recognitionId), image), jobPromise };
    },

    get(id) {
      const row = selectOne.get(id);
      if (!row) return null;
      return toPublic(row, storage.getMeta(row.image_id));
    },

    /** GET /api/status → queue.recognitionsPending. Ở chế độ sync gần như luôn 0. */
    pendingCount() {
      return countPending.get().n;
    },

    /** GET /api/status → queue.recognitionsFailedRecent. Cửa sổ 5 phút cố định. */
    failedRecentCount(windowMs = FAILED_RECENT_WINDOW_MS) {
      return countFailedSince.get(new Date(Date.now() - windowMs).toISOString()).n;
    },

    /**
     * Nguồn cho GET /api/admin/recognitions — mới-nhất-trước.
     * KHÔNG trả `fields`/`normalized`: monitor không cần dữ liệu nhãn, và đó là dữ liệu nghiệp vụ.
     * `counts` đếm TOÀN BẢNG, không chỉ trang hiện tại.
     */
    listForAdmin({ status = null, limit = 20, now = Date.now() } = {}) {
      const n = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 20));
      const rows = status ? selectAdminByStatus.all(status, n) : selectAdminAll.all(n);
      const counts = { pending: 0, completed: 0, failed: 0 };
      for (const row of countByStatus.all()) {
        if (Object.hasOwn(counts, row.status)) counts[row.status] = row.n;
      }
      const items = rows.map((row) => {
        let fieldsFound = 0;
        if (row.normalized) {
          try {
            const normalized = JSON.parse(row.normalized);
            fieldsFound = normalized?.fieldsFound ?? countOk(normalized?.fields);
          } catch {
            fieldsFound = 0;
          }
        }
        const createdMs = Date.parse(row.created_at);
        return {
          recognitionId: row.id,
          status: row.status,
          provider: row.provider,
          deviceId: row.device_id ?? null,
          sessionId: row.session_id ?? null,
          imageId: row.image_id,
          createdAt: row.created_at,
          finishedAt: row.finished_at ?? null,
          durationMs: row.duration_ms ?? null,
          // ageMs do SERVER tính — không bao giờ tin đồng hồ client.
          ageMs: Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : null,
          fieldsFound,
          errorCode: row.error_code ?? null,
        };
      });
      return { items, counts };
    },
  };
}
