import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/* Lớp lưu trữ ảnh. Mọi truy cập file ảnh đi qua đây để Phase 2 có thể:
 *   - đọc binary (getBuffer) gửi multipart cho AI server, hoặc
 *   - cấp URL HTTP (publicUrl) cho AI server tải về qua GET /api/images/:id.
 * Đường dẫn filesystem và blob URL của browser KHÔNG phải URL AI server truy cập được.
 */

const MAGIC = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

/* Nhận diện loại ảnh theo magic bytes, không tin content-type client gửi. */
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return MAGIC.find((m) => m.test(buffer)) || null;
}

export function createStorage({ uploadsDir, db }) {
  fs.mkdirSync(uploadsDir, { recursive: true });

  const insert = db.prepare(
    "INSERT INTO images (id, file_name, mime_type, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectOne = db.prepare("SELECT * FROM images WHERE id = ?");

  return {
    /* Ghi ảnh xuống đĩa với tên file do server tạo, rồi ghi metadata vào DB.
     * Ghi file trước, DB sau: nếu DB lỗi thì xoá file để không rác. */
    async saveImage(buffer) {
      const kind = sniffImage(buffer);
      if (!kind) throw Object.assign(new Error("Không phải ảnh JPEG/PNG/WebP"), { code: "UNSUPPORTED_IMAGE" });
      const id = crypto.randomUUID();
      const fileName = `${id}.${kind.ext}`;
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      const fullPath = path.join(uploadsDir, fileName);
      await fsp.writeFile(fullPath, buffer, { flag: "wx" });
      try {
        insert.run(id, fileName, kind.mime, buffer.length, sha256, new Date().toISOString());
      } catch (err) {
        await fsp.rm(fullPath, { force: true });
        throw err;
      }
      return { id, fileName, mimeType: kind.mime, bytes: buffer.length, sha256 };
    },

    getMeta(id) {
      const row = selectOne.get(id);
      if (!row) return null;
      return { id: row.id, fileName: row.file_name, mimeType: row.mime_type, bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at };
    },

    async getBuffer(id) {
      const meta = this.getMeta(id);
      if (!meta) return null;
      return fsp.readFile(path.join(uploadsDir, meta.fileName));
    },

    /* Đường dẫn tương đối để client cùng origin xem lại ảnh. */
    relativeUrl(id) {
      return `/api/images/${id}`;
    },

    /* URL tuyệt đối cho hệ thống ngoài (AI server) — cần PUBLIC_BASE_URL. */
    publicUrl(id, baseUrl) {
      if (!baseUrl) return null;
      return new URL(this.relativeUrl(id), baseUrl).toString();
    },
  };
}
