/* Vòng lặp nền nhặt job outbox tới hạn, gọi SAP adapter, rồi gọi lifecycle để chuyển trạng thái.
 * Worker KHÔNG bao giờ quét bảng receipts (trừ sweep lúc khởi động) — nguồn công việc duy nhất
 * của nó là bảng outbox. */

import { SapBusinessError, SapTechnicalError } from "./sap/adapter.js";
import { LifecycleError } from "./lifecycle.js";

/* Phiếu sinh trước ngưỡng này mà thiếu job mới được sweep — tránh đua với transaction INSERT
 * của một request vừa tới (L7). */
const MISSING_OUTBOX_MIN_AGE_MS = 60_000;

export function createOutboxWorker({ db, config, outbox, lifecycle, receipts, sessions, sap, logger } = {}) {
  let timer = null;
  let running = false;
  let stopped = false;

  /* Phiếu bị huỷ/thay thế trong lúc SAP đang chạy: transition bị từ chối nên không có patch nào
   * ghi post_attempts, mà job thì bị xoá ngay sau đó — postAttempts sẽ nói dối là "chưa từng gửi
   * SAP" đúng lúc SAP có thể đã cấp chứng từ mồ côi. Ghi thẳng số lần đã gọi để người điều tra
   * sau này biết phải đi hỏi SAP. */
  const recordPostAttempts = db.prepare("UPDATE receipts SET post_attempts = ? WHERE id = ?");

  const selectMissingOutbox = db.prepare(
    `SELECT r.id AS id, r.status AS status
       FROM receipts r
       LEFT JOIN outbox o ON o.receipt_id = r.id AND o.kind = 'post'
      WHERE r.status IN ('confirmed', 'corrected', 'posting')
        AND o.id IS NULL
        AND r.created_at < ?
        AND EXISTS (SELECT 1 FROM receipt_events e WHERE e.receipt_id = r.id)`,
  );

  /* Payload gửi SAP dựng ở worker chứ không ở adapter: adapter không được biết về DB. */
  function buildPayload(receiptId) {
    const receipt = receipts.get(receiptId);
    if (!receipt) return null;
    const session = receipt.sessionId ? sessions.get(receipt.sessionId) : null;
    return {
      receiptId: receipt.receiptId,
      createdAt: receipt.createdAt,
      deviceId: receipt.deviceId,
      sessionId: receipt.sessionId,
      warehouse: session?.warehouse ?? null,
      operator: session?.operator ?? null,
      data: receipt.data,
    };
  }

  /* L3: lỗi không phân loại được coi là lỗi KỸ THUẬT. Thà retry vô ích còn hơn đánh dấu
   * rejected oan một phiếu hợp lệ rồi bắt người vận hành nhập lại. */
  function asTechnical(err) {
    if (err instanceof SapTechnicalError) return err;
    return new SapTechnicalError("SAP_UNAVAILABLE", err?.message || "Lỗi không xác định khi gọi SAP");
  }

  function backoffFor(attempts) {
    const list = config.outbox.backoffsMs;
    if (!list?.length) return 0;
    return list[attempts - 1] ?? list[list.length - 1];
  }

  /* S1 + S2 của §6. Chạy MỖI LẦN BE khởi động, ngay trong start(). */
  let revivedOnBoot = 0;

  function sweepOnBoot() {
    const now = new Date().toISOString();
    const orphaned = outbox.inflightJobs();
    const inflight = outbox.reviveInflight(now);
    // Giữ lại con số cho detail.revivedOutbox của sự kiện server.start.
    revivedOnBoot = inflight;
    for (const job of orphaned) {
      try {
        lifecycle.note({
          receiptId: job.receiptId,
          event: "receipt.swept",
          actorKind: "system",
          detail: { sweep: "posting_stuck", attempt: job.attempts },
        });
      } catch (err) {
        logger?.warn("outbox.sweep_note_failed", { receiptId: job.receiptId, error: err?.message });
      }
    }

    let missing = 0;
    const cutoff = new Date(Date.now() - MISSING_OUTBOX_MIN_AGE_MS).toISOString();
    for (const row of selectMissingOutbox.all(cutoff)) {
      try {
        outbox.enqueue({ receiptId: row.id, kind: "post", nowIso: now });
        lifecycle.note({
          receiptId: row.id,
          event: "receipt.swept",
          actorKind: "system",
          detail: { sweep: "missing_outbox", attempt: 0 },
        });
        missing += 1;
      } catch (err) {
        logger?.warn("outbox.sweep_enqueue_failed", { receiptId: row.id, error: err?.message });
      }
    }

    logger?.info("outbox.sweep", { inflight, missing });
    return { inflight, missing };
  }

  async function handlePostSuccess(job, attempts, result) {
    lifecycle.transition({
      receiptId: job.receiptId,
      to: "posted",
      event: "receipt.posted",
      actorKind: "system",
      detail: { sapDocumentNo: result.sapDocumentNo, postedAt: result.postedAt, attempt: attempts },
      patch: { sap_document_no: result.sapDocumentNo, post_attempts: attempts },
      expectFrom: ["posting"],
    });
    outbox.remove(job.id);
  }

  function handleBusinessError(job, attempts, err) {
    if (job.kind === "post") {
      lifecycle.transition({
        receiptId: job.receiptId,
        to: "rejected",
        event: "receipt.rejected",
        actorKind: "system",
        detail: { code: err.code, sapMessage: err.sapMessage, attempt: attempts },
        patch: { reject_code: err.code, sap_message: err.sapMessage, post_attempts: attempts },
        expectFrom: ["posting"],
      });
      outbox.remove(job.id); // KHÔNG retry: gửi lại y hệt sẽ hỏng y hệt
      return;
    }
    lifecycle.note({
      receiptId: job.receiptId,
      event: "receipt.reversal_failed",
      actorKind: "system",
      detail: { code: err.code, attempt: attempts },
    });
    outbox.giveUp(job.id, { lastError: err.code });
  }

  function handleTechnicalError(job, attempts, err) {
    if (attempts < config.sap.maxAttempts) {
      const delayMs = backoffFor(attempts);
      const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
      outbox.reschedule(job.id, { at: nextAttemptAt, lastError: err.code });
      if (job.kind === "post") {
        lifecycle.note({
          receiptId: job.receiptId,
          event: "receipt.post_retry",
          actorKind: "system",
          detail: { attempt: attempts, code: err.code, nextAttemptAt, delayMs },
        });
      }
      return;
    }
    outbox.giveUp(job.id, { lastError: err.code });
    if (job.kind === "post") {
      lifecycle.transition({
        receiptId: job.receiptId,
        to: "post_failed",
        event: "receipt.post_failed",
        actorKind: "system",
        detail: { attempt: attempts, code: err.code, lastError: err.message },
        patch: { post_attempts: attempts },
        expectFrom: ["posting"],
      });
      return;
    }
    lifecycle.note({
      receiptId: job.receiptId,
      event: "receipt.reversal_failed",
      actorKind: "system",
      detail: { code: err.code, attempt: attempts },
    });
  }

  async function handle(job) {
    const status = lifecycle.statusOf(job.receiptId);
    if (status === null) {
      outbox.remove(job.id); // phiếu biến mất (DB bị sửa tay) — không có gì để gửi
      return;
    }
    if (job.kind === "post" && (status === "cancelled" || status === "superseded")) {
      outbox.remove(job.id);
      return;
    }

    const marked = outbox.markInflight(job.id, new Date().toISOString());
    if (!marked) return; // ai đó đã nhặt job này trước
    const attempts = marked.attempts;

    if (job.kind === "post") {
      try {
        lifecycle.transition({
          receiptId: job.receiptId,
          to: "posting",
          event: "receipt.posting",
          actorKind: "system",
          detail: { attempt: attempts },
          expectFrom: ["confirmed", "corrected", "posting", "post_failed"],
        });
      } catch (err) {
        if (!(err instanceof LifecycleError)) throw err;
        logger?.warn("outbox.stale_job", { receiptId: job.receiptId, from: err.from, intendedTo: err.to });
        outbox.remove(job.id);
        return;
      }
    }

    let result;
    try {
      if (job.kind === "reversal") {
        const receipt = receipts.get(job.receiptId);
        result = await sap.reverseGoodsReceipt(
          { receiptId: job.receiptId, sapDocumentNo: receipt?.sapDocumentNo ?? null },
          { signal: AbortSignal.timeout(config.sap.timeoutMs) },
        );
      } else {
        const payload = buildPayload(job.receiptId);
        result = await sap.postGoodsReceipt(payload, { signal: AbortSignal.timeout(config.sap.timeoutMs) });
      }
    } catch (err) {
      // BE đang đóng: đừng ghi vào một DB sắp/đã đóng, tick sau của lần khởi động kế tiếp sẽ sweep.
      if (stopped) return;
      try {
        if (err instanceof SapBusinessError) handleBusinessError(job, attempts, err);
        else handleTechnicalError(job, attempts, asTechnical(err));
      } catch (writeErr) {
        if (writeErr instanceof LifecycleError) {
          // Phiếu bị huỷ/thay thế trong lúc SAP đang chạy: kết quả này đã cũ, bỏ đi.
          logger?.warn("outbox.stale_result", { receiptId: job.receiptId, from: writeErr.from, intendedTo: writeErr.to });
          if (job.kind === "post") recordPostAttempts.run(attempts, job.receiptId);
          outbox.remove(job.id);
          return;
        }
        throw writeErr;
      }
      return;
    }

    if (stopped) return;
    try {
      if (job.kind === "reversal") {
        lifecycle.note({
          receiptId: job.receiptId,
          event: "receipt.reversal_posted",
          actorKind: "system",
          detail: { sapDocumentNo: result.reversalDocumentNo, attempt: attempts },
        });
        outbox.remove(job.id);
        return;
      }
      await handlePostSuccess(job, attempts, result);
    } catch (err) {
      if (!(err instanceof LifecycleError)) throw err;
      logger?.warn("outbox.stale_result", { receiptId: job.receiptId, from: err.from, intendedTo: err.to });
      if (job.kind === "post") recordPostAttempts.run(attempts, job.receiptId);
      outbox.remove(job.id);
    }
  }

  /* Một exception thoát ra khỏi callback của setInterval là unhandled rejection → giết tiến
   * trình BE. Toàn bộ thân tick nằm trong try/catch, luôn luôn. */
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const jobs = outbox.due(new Date().toISOString(), 10);
      // Tuần tự, KHÔNG Promise.all: SQLite chỉ có một writer, chạy song song chỉ tạo SQLITE_BUSY.
      for (const job of jobs) {
        if (stopped) break;
        await handle(job);
      }
    } catch (err) {
      logger?.error("outbox.tick_failed", { error: err?.message, stack: err?.stack });
    } finally {
      running = false;
    }
  }

  return {
    sweepOnBoot,
    tick,

    start() {
      if (config.sap.adapter === "none" || !sap) {
        logger?.info("outbox.worker_disabled", { reason: "sap_adapter_none" });
        return false;
      }
      if (config.outbox.enabled === false) {
        logger?.info("outbox.worker_disabled", { reason: "outbox_disabled" });
        return false;
      }
      stopped = false;
      sweepOnBoot();
      timer = setInterval(() => {
        tick();
      }, config.outbox.tickMs);
      // BẮT BUỘC: không unref() thì `node --test` treo vô hạn sau khi test xong (L5).
      timer.unref();
      logger?.info("outbox.worker_started", { tickMs: config.outbox.tickMs, adapter: config.sap.adapter });
      return true;
    },

    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },

    get isRunning() {
      return timer !== null;
    },

    /** Số job 'inflight' đã được hồi sinh ở lần sweepOnBoot gần nhất (0 nếu worker tắt). */
    get revivedOnBoot() {
      return revivedOnBoot;
    },
  };
}
