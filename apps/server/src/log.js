/* Logger tối giản: một dòng JSON mỗi sự kiện. KHÔNG bao giờ log nội dung ảnh/base64
 * hay body request; chỉ log định danh và kích thước. */
export function log(level, msg, extra = {}) {
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

export const logger = {
  info: (msg, extra) => log("info", msg, extra),
  warn: (msg, extra) => log("warn", msg, extra),
  error: (msg, extra) => log("error", msg, extra),
  silent: { info() {}, warn() {}, error() {} },
};
