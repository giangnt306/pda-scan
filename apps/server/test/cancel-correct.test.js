import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  startSapApp,
  startRulesApp,
  postJson,
  putJson,
  getJson,
  upload,
  receiptBody,
  validData,
  waitFor,
  JPEG,
  DEVICE_A,
} from "./helpers.js";

const CANCELLABLE_FROM = ["confirmed", "posting", "posted", "post_failed", "rejected", "corrected"];
const CORRECTABLE_FROM = ["confirmed", "posting", "post_failed", "rejected", "corrected"];
const STATE_INVALID_MSG = "Không thực hiện được thao tác này với trạng thái hiện tại của phiếu";

const hdr = { "x-device-id": DEVICE_A };
const outboxRows = (t, receiptId) => t.app.db.prepare("SELECT * FROM outbox WHERE receipt_id = ? ORDER BY id").all(receiptId);
const eventsOf = async (t, id) => (await getJson(t.base, `/api/receipts/${id}/events`)).body.items;

async function makeReceipt(t, requestId, extra = {}) {
  const res = await postJson(t.base, "/api/receipts", receiptBody(requestId, extra), hdr);
  assert.equal(res.status, 201, `không tạo được phiếu ${requestId}: ${JSON.stringify(res.body)}`);
  return res.body;
}

test('cancel: thiếu reason hoặc reason rỗng/quá 200 ký tự → 400 INVALID_BODY field "reason"; hợp lệ → 200 status cancelled, cancelReason đúng', async () => {
  const t = await startTestApp();
  try {
    const r = await makeReceipt(t, "cxl-valid-000001");
    const url = `/api/receipts/${r.receiptId}/cancel`;

    for (const [label, body] of [
      ["thiếu reason", {}],
      ["reason rỗng", { reason: "" }],
      ["reason chỉ có khoảng trắng", { reason: "    " }],
      ["reason 201 ký tự", { reason: "x".repeat(201) }],
      ["reason không phải chuỗi", { reason: 12345 }],
      ["reason là null", { reason: null }],
    ]) {
      const res = await postJson(t.base, url, body, hdr);
      assert.equal(res.status, 400, `${label} phải bị từ chối`);
      assert.equal(res.body.error.code, "INVALID_BODY", label);
      assert.equal(res.body.error.details.field, "reason", label);
    }
    /* Body không phải object → INVALID_BODY nhưng field là "body", không phải "reason". */
    const notObject = await postJson(t.base, url, [1, 2, 3], hdr);
    assert.equal(notObject.status, 400);
    assert.equal(notObject.body.error.details.field, "body");

    /* Phiếu vẫn nguyên vẹn sau 7 lần bị từ chối. */
    assert.equal((await getJson(t.base, `/api/receipts/${r.receiptId}`)).body.status, "confirmed");

    const ok = await postJson(t.base, url, { reason: "  Nhập nhầm pallet  " }, hdr);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "cancelled");
    assert.equal(ok.body.cancelReason, "Nhập nhầm pallet", "reason phải được trim trước khi lưu");
    assert.equal(ok.body.receiptId, r.receiptId);
    assert.equal(ok.body.reversalQueued, false, "phiếu chưa posted thì không có gì để đảo");

    const events = await eventsOf(t, r.receiptId);
    const cancelled = events.filter((e) => e.event === "receipt.cancelled");
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].to, "cancelled");
    assert.equal(cancelled[0].actor.kind, "operator");
    assert.equal(cancelled[0].detail.reason, "Nhập nhầm pallet");

    /* Đúng 200 ký tự là ranh giới hợp lệ. */
    const r2 = await makeReceipt(t, "cxl-edge-0000001", { data: { ...validData(), partNumber: "BEX32181030ZZ" } });
    const edge = await postJson(t.base, `/api/receipts/${r2.receiptId}/cancel`, { reason: "y".repeat(200) }, hdr);
    assert.equal(edge.status, 200);
    assert.equal(edge.body.cancelReason.length, 200);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("cancel: phiếu đã posted → reversalQueued=true, tạo job outbox kind='reversal', ghi receipt.reversal_queued; sapDocumentNo KHÔNG bị xoá", async () => {
  const t = await startSapApp({ sap: { adapter: "mock", mockSuccessDelayMs: 0 } });
  try {
    const r = await makeReceipt(t, "cxl-posted-00001");
    const posted = await waitFor(
      async () => {
        const got = (await getJson(t.base, `/api/receipts/${r.receiptId}`)).body;
        return got.status === "posted" ? got : null;
      },
      { timeoutMs: 8000, label: "phiếu posted" },
    );
    assert.match(posted.sapDocumentNo, /^5000\d{6}$/);

    /* SAP ngừng hoạt động TRƯỚC khi huỷ: job reversal sẽ thất bại kỹ thuật và ở lại bảng outbox,
     * nhờ vậy khẳng định về job không phải đua với worker. */
    assert.equal((await putJson(t.base, "/api/admin/sim", { sap: { mode: "down" } })).status, 200);

    const cancelled = await postJson(t.base, `/api/receipts/${r.receiptId}/cancel`, { reason: "Huỷ sau khi đã gửi SAP" }, hdr);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal(cancelled.body.reversalQueued, true);
    assert.equal(cancelled.body.sapDocumentNo, posted.sapDocumentNo, "chứng từ đã tồn tại trong SAP: không được xoá số");

    const rows = outboxRows(t, r.receiptId);
    assert.equal(rows.filter((x) => x.kind === "post").length, 0, "job gửi phải bị xoá khi huỷ");
    const reversal = rows.filter((x) => x.kind === "reversal");
    assert.equal(reversal.length, 1, "phải có đúng một job đảo chứng từ");

    const events = await eventsOf(t, r.receiptId);
    const queued = events.filter((e) => e.event === "receipt.reversal_queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].detail.sapDocumentNo, posted.sapDocumentNo);
    assert.equal(queued[0].to, "cancelled", "ghi lệnh đảo KHÔNG đổi trạng thái phiếu (Q22)");

    /* Đọc lại qua GET: sapDocumentNo vẫn còn, trạng thái vẫn là cancelled. */
    const reread = (await getJson(t.base, `/api/receipts/${r.receiptId}`)).body;
    assert.equal(reread.status, "cancelled");
    assert.equal(reread.sapDocumentNo, posted.sapDocumentNo);
    assert.equal(reread.cancelReason, "Huỷ sau khi đã gửi SAP");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("cancel: phiếu đang cancelled hoặc superseded → 409 RECEIPT_STATE_INVALID với details.current và allowed", async () => {
  const t = await startTestApp();
  try {
    const a = await makeReceipt(t, "cxl-twice-000001");
    assert.equal((await postJson(t.base, `/api/receipts/${a.receiptId}/cancel`, { reason: "Huỷ lần đầu" }, hdr)).status, 200);

    const again = await postJson(t.base, `/api/receipts/${a.receiptId}/cancel`, { reason: "Huỷ lần hai" }, hdr);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "RECEIPT_STATE_INVALID");
    assert.equal(again.body.error.message, STATE_INVALID_MSG);
    assert.equal(again.body.error.details.current, "cancelled");
    assert.deepEqual(again.body.error.details.allowed, CANCELLABLE_FROM);
    assert.equal((await getJson(t.base, `/api/receipts/${a.receiptId}`)).body.cancelReason, "Huỷ lần đầu", "lý do cũ không được ghi đè");

    const b = await makeReceipt(t, "cxl-super-000001", { data: { ...validData(), partNumber: "BEX32181030XX" } });
    const corrected = await postJson(
      t.base,
      `/api/receipts/${b.receiptId}/correct`,
      { requestId: "cxl-super-000002", data: { ...validData(), partNumber: "BEX32181030XX", quantity: 78 } },
      hdr,
    );
    assert.equal(corrected.status, 201);

    const cancelSuperseded = await postJson(t.base, `/api/receipts/${b.receiptId}/cancel`, { reason: "Huỷ phiếu đã bị thay thế" }, hdr);
    assert.equal(cancelSuperseded.status, 409);
    assert.equal(cancelSuperseded.body.error.code, "RECEIPT_STATE_INVALID");
    assert.equal(cancelSuperseded.body.error.details.current, "superseded");
    assert.deepEqual(cancelSuperseded.body.error.details.allowed, CANCELLABLE_FROM);

    /* Phiếu SỬA (đang sống) thì vẫn huỷ được — "corrected" nằm trong danh sách allowed. */
    const cancelNew = await postJson(t.base, `/api/receipts/${corrected.body.receiptId}/cancel`, { reason: "Huỷ phiếu sửa" }, hdr);
    assert.equal(cancelNew.status, 200);
    assert.equal(cancelNew.body.status, "cancelled");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("correct: tạo phiếu mới status='corrected' supersedesReceiptId=<cũ>; phiếu cũ thành superseded supersededByReceiptId=<mới>; kế thừa recognitionId/imageId/source", async () => {
  const t = await startTestApp();
  try {
    const rec = await upload(t.base, JPEG);
    assert.equal(rec.status, 201);
    const old = await makeReceipt(t, "cor-old-00000001", { recognitionId: rec.body.recognitionId, source: "camera" });
    assert.equal(old.source, "camera");
    assert.equal(old.recognitionId, rec.body.recognitionId);
    assert.ok(old.imageId);

    const res = await postJson(
      t.base,
      `/api/receipts/${old.receiptId}/correct`,
      {
        requestId: "cor-new-00000001",
        data: { ...validData(), quantity: 78 },
        fieldMeta: {},
        reason: "Đếm lại còn 78",
      },
      hdr,
    );
    assert.equal(res.status, 201);
    const created = res.body;
    assert.notEqual(created.receiptId, old.receiptId);
    assert.equal(created.status, "corrected");
    assert.equal(created.supersedesReceiptId, old.receiptId);
    assert.equal(created.supersededByReceiptId, null);
    assert.equal(created.requestId, "cor-new-00000001");
    assert.equal(created.data.quantity, 78);
    assert.equal(created.sapDocumentNo, null);
    assert.equal(created.rejectCode, null);
    assert.equal(created.postAttempts, 0);
    assert.equal(created.cancelReason, null);

    /* Q23: ảnh và recognition kế thừa nguyên từ phiếu cũ — nhãn không đổi khi sửa số lượng. */
    assert.equal(created.recognitionId, old.recognitionId);
    assert.equal(created.imageId, old.imageId);
    assert.equal(created.imageUrl, old.imageUrl);
    assert.equal(created.source, old.source);

    const reread = (await getJson(t.base, `/api/receipts/${old.receiptId}`)).body;
    assert.equal(reread.status, "superseded");
    assert.equal(reread.supersededByReceiptId, created.receiptId);
    assert.equal(reread.data.quantity, 80, "phiếu cũ KHÔNG bị ghi đè, chỉ bị đánh dấu thay thế");

    const oldEvents = await eventsOf(t, old.receiptId);
    const supersededEvent = oldEvents.filter((e) => e.event === "receipt.superseded");
    assert.equal(supersededEvent.length, 1);
    assert.equal(supersededEvent[0].detail.supersededByReceiptId, created.receiptId);
    assert.equal(supersededEvent[0].detail.reason, "Đếm lại còn 78");

    const newEvents = await eventsOf(t, created.receiptId);
    const correctedEvent = newEvents.filter((e) => e.event === "receipt.corrected");
    assert.equal(correctedEvent.length, 1);
    assert.equal(correctedEvent[0].detail.supersedesReceiptId, old.receiptId);

    /* Chuỗi A → B → C: phiếu corrected vẫn sửa tiếp được (§14 câu 11). */
    const third = await postJson(
      t.base,
      `/api/receipts/${created.receiptId}/correct`,
      { requestId: "cor-new-00000002", data: { ...validData(), quantity: 77 } },
      hdr,
    );
    assert.equal(third.status, 201);
    assert.equal(third.body.supersedesReceiptId, created.receiptId);
    assert.equal((await getJson(t.base, `/api/receipts/${created.receiptId}`)).body.status, "superseded");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("correct: requestId trùng phiếu đang có → 409 REQUEST_ID_CONFLICT; data sai → 422 VALIDATION_FAILED; phiếu posted → 409 RECEIPT_STATE_INVALID", async () => {
  const t = await startTestApp();
  try {
    const old = await makeReceipt(t, "cor-conf-0000001");
    const url = `/api/receipts/${old.receiptId}/correct`;

    /* requestId của CHÍNH phiếu cũ cũng bị từ chối (Q24): hai phiếu khác nhau không dùng chung khoá. */
    const conflict = await postJson(t.base, url, { requestId: "cor-conf-0000001", data: { ...validData(), quantity: 78 } }, hdr);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "REQUEST_ID_CONFLICT");
    assert.equal(conflict.body.error.details.receiptId, old.receiptId);
    assert.equal((await getJson(t.base, `/api/receipts/${old.receiptId}`)).body.status, "confirmed", "409 phải là chặn, không được đổi trạng thái phiếu cũ");

    const badRequestId = await postJson(t.base, url, { requestId: "ngan", data: { ...validData(), quantity: 78 } }, hdr);
    assert.equal(badRequestId.status, 400);
    assert.equal(badRequestId.body.error.code, "INVALID_REQUEST_ID");
    assert.equal(badRequestId.body.error.message, "requestId phải là chuỗi 8–128 ký tự [A-Za-z0-9_-]");

    const badData = await postJson(t.base, url, { requestId: "cor-bad-00000001", data: { ...validData(), quantity: 0 } }, hdr);
    assert.equal(badData.status, 422);
    assert.equal(badData.body.error.code, "VALIDATION_FAILED");
    assert.ok(badData.body.error.details.fields.quantity, "phải chỉ đúng ô sai cho FE tô đỏ");

    const noData = await postJson(t.base, url, { requestId: "cor-nodata-00001" }, hdr);
    assert.equal(noData.status, 400);
    assert.equal(noData.body.error.code, "INVALID_BODY");
    assert.equal(noData.body.error.details.field, "data");

    const missing = await postJson(
      t.base,
      "/api/receipts/00000000-0000-0000-0000-000000000000/correct",
      { requestId: "cor-missing-0001", data: validData() },
      hdr,
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");
  } finally {
    await t.stop();
    t.cleanup();
  }

  /* Phiếu đã posted phải huỷ rồi nhập lại, không sửa được — cần app có SAP mock thật. */
  const s = await startSapApp({ sap: { adapter: "mock", mockSuccessDelayMs: 0 } });
  try {
    const r = await makeReceipt(s, "cor-posted-00001");
    await waitFor(async () => (await getJson(s.base, `/api/receipts/${r.receiptId}`)).body.status === "posted", {
      timeoutMs: 8000,
      label: "phiếu posted",
    });
    const res = await postJson(
      s.base,
      `/api/receipts/${r.receiptId}/correct`,
      { requestId: "cor-posted-00002", data: { ...validData(), quantity: 78 } },
      hdr,
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "RECEIPT_STATE_INVALID");
    assert.equal(res.body.error.details.current, "posted");
    assert.deepEqual(res.body.error.details.allowed, CORRECTABLE_FROM);
  } finally {
    await s.stop();
    s.cleanup();
  }
});

test("correct: BỎ QUA rule trùng nhãn (data y hệt phiếu cũ vẫn 201) nhưng VẪN áp rule vị trí (location lạ → 422)", async () => {
  const t = await startRulesApp();
  try {
    const old = await makeReceipt(t, "cor-rules-000001");

    /* Đối chứng: đi qua POST /api/receipts thì đúng data này BỊ chặn vì trùng nhãn. */
    const viaCreate = await postJson(t.base, "/api/receipts", receiptBody("cor-rules-000002"), hdr);
    assert.equal(viaCreate.status, 409);
    assert.equal(viaCreate.body.error.code, "DUPLICATE_LABEL");

    /* Còn correct thì KHÔNG kiểm trùng (Q25): phiếu sửa gần như chắc chắn trùng với phiếu nó thay thế. */
    const same = await postJson(t.base, `/api/receipts/${old.receiptId}/correct`, { requestId: "cor-rules-000003", data: validData() }, hdr);
    assert.equal(same.status, 201, "sửa phiếu không được vướng rule trùng nhãn");
    assert.equal(same.body.supersedesReceiptId, old.receiptId);

    /* Nhưng rule vị trí thì vẫn áp: location ngoài danh mục → 422 kèm gợi ý. */
    const badLocation = await postJson(
      t.base,
      `/api/receipts/${same.body.receiptId}/correct`,
      { requestId: "cor-rules-000004", data: { ...validData(), location: "A-99-99" } },
      hdr,
    );
    assert.equal(badLocation.status, 422);
    assert.equal(badLocation.body.error.code, "LOCATION_UNKNOWN");
    assert.equal(badLocation.body.error.details.field, "location");
    assert.ok(Array.isArray(badLocation.body.error.details.suggestions));
    assert.ok(badLocation.body.error.details.suggestions.length <= 3);

    /* Phiếu vẫn nguyên: 422 chặn trước khi ghi bất cứ thứ gì. */
    assert.equal((await getJson(t.base, `/api/receipts/${same.body.receiptId}`)).body.status, "corrected");
    assert.equal((await getJson(t.base, "/api/receipts?limit=200")).body.items.length, 2);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

/* transport.js gửi lại thao tác `kind: "save"` khi response rớt trên đường về (tối đa 2
 * lần, cùng `requestId` trong body, chỉ `x-request-id` truy vết là đổi). Từ phía BE, "response
 * rớt" và "client không nhận được response" là cùng một thứ: request thứ hai tới nơi y hệt
 * request thứ nhất đã commit xong. Phải trả lại kết quả cũ, không được báo lỗi cho một thao tác
 * đã thành công — nếu không người vận hành sẽ sửa thêm lần nữa và sinh hai phiếu cho một lần sửa. */
test("correct gửi lại cùng requestId + cùng data sau khi lần 1 ĐÃ commit (response rớt) → 200 kèm ĐÚNG phiếu sửa đã tạo, KHÔNG tạo phiếu thứ hai, KHÔNG 409", async () => {
  /* adapter mock + worker TẮT: khẳng định được về dòng outbox mà không phải đua với worker. */
  const t = await startTestApp({ sap: { adapter: "mock" }, outbox: { enabled: false, tickMs: 20 } });
  try {
    const old = await makeReceipt(t, "cor-retry-old-001");
    const url = `/api/receipts/${old.receiptId}/correct`;
    const body = { requestId: "cor-retry-new-001", data: { ...validData(), quantity: 78 }, fieldMeta: {}, reason: "Đếm lại còn 78" };

    const first = await postJson(t.base, url, body, { ...hdr, "x-request-id": "11111111-1111-4111-8111-111111111111" });
    assert.equal(first.status, 201);
    const newId = first.body.receiptId;

    // Lần gửi lại: body byte-for-byte như cũ, chỉ header truy vết đổi (Q2).
    const retry = await postJson(t.base, url, body, { ...hdr, "x-request-id": "22222222-2222-4222-8222-222222222222" });
    assert.equal(retry.status, 200, `lần gửi lại phải là 200, nhận ${retry.status}: ${JSON.stringify(retry.body)}`);
    assert.equal(retry.body.receiptId, newId, "phải trả lại đúng phiếu sửa đã tạo, không phải phiếu mới");
    assert.equal(retry.body.status, "corrected");
    assert.equal(retry.body.supersedesReceiptId, old.receiptId);
    assert.equal(retry.body.data.quantity, 78);
    assert.equal(retry.body.idempotent, undefined, "chỉ POST /api/receipts mới có key idempotent (§1)");

    // Đúng 2 phiếu trong DB: phiếu gốc + một phiếu sửa.
    const all = (await getJson(t.base, "/api/receipts?limit=200")).body.items;
    assert.deepEqual(all.map((r) => r.receiptId).sort(), [old.receiptId, newId].sort(), "không được sinh phiếu sửa thứ hai");

    // Phiếu cũ vẫn trỏ về đúng một phiếu thay thế, và chỉ bị ghi sự kiện một lần.
    const reread = (await getJson(t.base, `/api/receipts/${old.receiptId}`)).body;
    assert.equal(reread.status, "superseded");
    assert.equal(reread.supersededByReceiptId, newId);
    assert.equal((await eventsOf(t, old.receiptId)).filter((e) => e.event === "receipt.superseded").length, 1);
    assert.equal((await eventsOf(t, newId)).filter((e) => e.event === "receipt.corrected").length, 1);

    // Hàng đợi gửi SAP: đúng một job cho phiếu mới, không job nào cho phiếu cũ.
    assert.equal(outboxRows(t, old.receiptId).length, 0);
    assert.deepEqual(outboxRows(t, newId).map((r) => r.kind), ["post"]);

    /* Chốt: đường idempotent KHÔNG mở lỗ cho thao tác sửa mới trên phiếu đã bị thay thế. */
    const other = await postJson(t.base, url, { requestId: "cor-retry-new-002", data: { ...validData(), quantity: 77 } }, hdr);
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, "RECEIPT_STATE_INVALID");
    assert.equal(other.body.error.details.current, "superseded");
    assert.deepEqual(other.body.error.details.allowed, CORRECTABLE_FROM);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("correct: cùng requestId nhưng data KHÁC → 409 REQUEST_ID_CONFLICT; cùng requestId dùng cho phiếu gốc KHÁC → cũng 409, và không phiếu nào bị đổi trạng thái", async () => {
  const t = await startTestApp();
  try {
    const a = await makeReceipt(t, "cor-conflict-a-01");
    const b = await makeReceipt(t, "cor-conflict-b-01", { data: { ...validData(), partNumber: "BEX32181030QQ" } });

    const first = await postJson(
      t.base,
      `/api/receipts/${a.receiptId}/correct`,
      { requestId: "cor-conflict-new1", data: { ...validData(), quantity: 78 } },
      hdr,
    );
    assert.equal(first.status, 201);
    const newId = first.body.receiptId;

    // Cùng requestId, NỘI DUNG khác → không phải lần gửi lại, mà là dùng nhầm khoá.
    const otherData = await postJson(
      t.base,
      `/api/receipts/${a.receiptId}/correct`,
      { requestId: "cor-conflict-new1", data: { ...validData(), quantity: 77 } },
      hdr,
    );
    assert.equal(otherData.status, 409);
    assert.equal(otherData.body.error.code, "REQUEST_ID_CONFLICT");
    assert.equal(otherData.body.error.message, "requestId này đã được lưu với nội dung khác");
    assert.equal(otherData.body.error.details.receiptId, newId, "phải chỉ ra phiếu đang giữ requestId đó");

    // Cùng requestId, cùng data, nhưng PHIẾU GỐC khác → cũng là dùng nhầm khoá.
    const otherParent = await postJson(
      t.base,
      `/api/receipts/${b.receiptId}/correct`,
      { requestId: "cor-conflict-new1", data: { ...validData(), quantity: 78 } },
      hdr,
    );
    assert.equal(otherParent.status, 409);
    assert.equal(otherParent.body.error.code, "REQUEST_ID_CONFLICT");
    assert.equal(otherParent.body.error.details.receiptId, newId);

    // Hai lần 409 là chặn thuần: không phiếu nào đổi trạng thái, không phiếu nào được thêm.
    assert.equal((await getJson(t.base, `/api/receipts/${b.receiptId}`)).body.status, "confirmed");
    assert.equal((await getJson(t.base, `/api/receipts/${a.receiptId}`)).body.supersededByReceiptId, newId);
    assert.equal((await getJson(t.base, "/api/receipts?limit=200")).body.items.length, 3);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
