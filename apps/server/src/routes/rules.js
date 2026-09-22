/* Huỷ phiếu và sửa phiếu (§5, §6).
 *
 * Ranh giới (L11): việc GHI vào receipts/outbox/receipt_events nằm trong receipts.cancel() và
 * receipts.createCorrection() — ở đây chỉ có phần NGHIỆP VỤ: đọc body, kiểm hình thức, kiểm
 * danh mục vị trí, rồi gọi xuống. Không có INSERT/UPDATE/DELETE nào trong file này (K2).
 */
import { validateReceiptData } from "../fields.js";

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_REASON = 200;

/* readJson là hàm riêng trong http.js, không export được mà không buộc BE-1 sửa file ở Stage 2
 * (QUYẾT ĐỊNH K1). Lặp lại 12 dòng này rẻ hơn một lần phá vỡ quyền sở hữu file — giữ ĐÚNG 4 mã
 * lỗi và 4 chuỗi message của http.js để hành vi đồng nhất. */
async function readJsonBody(req, ApiError) {
  const ct = req.headers["content-type"] || "";
  if (!ct.startsWith("application/json")) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Cần Content-Type application/json");
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Body vượt giới hạn ${MAX_BODY_BYTES} byte`);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Body không phải JSON hợp lệ");
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function rulesRoutes({ receipts, rules, ApiError }) {
  const objectBodyOrThrow = (raw) => {
    if (!isPlainObject(raw)) throw new ApiError(400, "INVALID_BODY", "Body phải là JSON object", { field: "body" });
    return raw;
  };

  return [
    {
      method: "POST",
      pattern: /^\/api\/receipts\/([0-9a-f-]{36})\/cancel$/,
      handler: async (req, m, _u, _r, ctx) => {
        const body = objectBodyOrThrow(await readJsonBody(req, ApiError));
        const reason = typeof body.reason === "string" ? body.reason.trim() : null;
        /* Lý do huỷ là bắt buộc: phiếu bị huỷ mà không ai biết vì sao thì sổ kiểm toán vô dụng. */
        if (reason === null || reason.length < 1 || reason.length > MAX_REASON) {
          throw new ApiError(400, "INVALID_BODY", `reason phải là chuỗi 1–${MAX_REASON} ký tự`, { field: "reason" });
        }
        /* 404 NOT_FOUND và 409 RECEIPT_STATE_INVALID do receipts.cancel ném ra (ReceiptError). */
        const { receipt, reversalQueued } = receipts.cancel({
          receiptId: m[1],
          reason,
          deviceId: ctx.deviceId,
          sessionId: ctx.sessionId,
        });
        /* reversalQueued CHỈ có trên response của endpoint này, không phải field của phiếu. */
        return { status: 200, body: { ...receipt, reversalQueued } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/receipts\/([0-9a-f-]{36})\/correct$/,
      handler: async (req, m, _u, _r, ctx) => {
        const body = objectBodyOrThrow(await readJsonBody(req, ApiError));

        const { requestId } = body;
        if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
          /* Đúng chuỗi message của receipts.js: hai đường vào cùng một quy tắc thì FE chỉ phải
           * hiểu một câu. */
          throw new ApiError(400, "INVALID_REQUEST_ID", "requestId phải là chuỗi 8–128 ký tự [A-Za-z0-9_-]");
        }
        if (!isPlainObject(body.data)) {
          throw new ApiError(400, "INVALID_BODY", "data phải là JSON object", { field: "data" });
        }
        let reason = null;
        if (body.reason !== undefined && body.reason !== null) {
          if (typeof body.reason !== "string" || body.reason.trim().length > MAX_REASON) {
            throw new ApiError(400, "INVALID_BODY", `reason phải là chuỗi tối đa ${MAX_REASON} ký tự`, { field: "reason" });
          }
          reason = body.reason.trim() === "" ? null : body.reason.trim();
        }

        const validation = validateReceiptData(body.data);
        if (!validation.ok) {
          throw new ApiError(422, "VALIDATION_FAILED", "Dữ liệu chưa hợp lệ", { fields: validation.errors });
        }
        /* Rule vị trí VẪN áp dụng, rule trùng nhãn thì KHÔNG (Q25). */
        rules.checkLocationOnly(validation.data);

        const { receipt, created } = receipts.createCorrection({
          oldReceiptId: m[1],
          requestId,
          data: validation.data,
          fieldMeta: isPlainObject(body.fieldMeta) ? body.fieldMeta : {},
          reason,
          deviceId: ctx.deviceId,
          sessionId: ctx.sessionId,
        });
        /* Gửi lại cùng requestId + cùng nội dung (transport.js retry kind "save" khi response
         * rớt) → 200 kèm phiếu sửa đã tạo, thay vì 409 cho một thao tác đã thành công.
         * KHÔNG thêm key `idempotent` vào body: §1 chốt rằng chỉ POST /api/receipts có key đó,
         * ở đây 200 (đã có) đối lại 201 (vừa tạo) đã đủ để FE phân biệt. */
        return { status: created === false ? 200 : 201, body: receipt };
      },
    },
  ];
}
