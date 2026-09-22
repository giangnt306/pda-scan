/* Danh mục dữ liệu chủ (vị trí kho, kho, ca làm việc).
 *
 * Nguồn là ba file TĨNH trong src/master-data/ chứ không phải DATA_DIR (Q27): đây là mã nguồn có
 * version, không phải dữ liệu runtime. Đọc MỘT LẦN lúc khởi động rồi giữ trong RAM — mỗi request
 * chỉ lọc trên mảng đã nạp.
 *
 * Một file danh mục hỏng KHÔNG được phép chặn khởi động, và cũng không được phép làm cả kho ngừng
 * nhập hàng: xem hasLocation (fail-open, Q28).
 */
import fs from "node:fs";
import path from "node:path";

const LOCATIONS_HEADER = "code,zone,name,active";

/* Parser CSV tối giản, đúng như hợp đồng §7.4: KHÔNG hỗ trợ dấu phẩy trong ô, KHÔNG hỗ trợ nháy
 * kép. Tên vị trí cần dấu phẩy thì đổi tên, đừng nâng cấp parser.
 * Header sai → ném: file đó không phải danh mục vị trí, và nạp bừa sẽ sinh ra mã rác mà rule
 * trùng/vị trí lại tin là thật. */
export function parseLocationsCsv(text) {
  const out = [];
  let headerSeen = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!headerSeen) {
      if (line !== LOCATIONS_HEADER) throw new Error(`Header phải đúng "${LOCATIONS_HEADER}", nhận "${line.slice(0, 60)}"`);
      headerSeen = true;
      continue;
    }
    const c = line.split(",");
    if (c.length < 4) continue; // dòng cụt: bỏ, không làm hỏng cả danh mục
    const code = c[0].trim();
    if (!code) continue;
    out.push({ code, zone: c[1].trim(), name: c[2].trim(), active: c[3].trim() === "1" });
  }
  if (!headerSeen) throw new Error("File rỗng hoặc thiếu dòng header");
  return out;
}

function readJsonArray(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Nội dung phải là một mảng JSON");
  return parsed;
}

/**
 * @returns {{
 *   locations:  (opts?: { q?: string, limit?: number, includeInactive?: boolean }) => { items: Array<{code:string,zone:string,name:string,active:boolean}>, total: number },
 *   warehouses: () => Array<{code:string,name:string,active:boolean}>,
 *   shifts:     () => Array<{code:string,name:string,startsAt:string,endsAt:string}>,
 *   hasLocation:(code: string) => boolean,
 *   suggestLocations: (code: string, max?: number) => string[],
 *   loaded:     boolean
 * }}
 */
export function createMasterService({ config, logger } = {}) {
  const dir = config?.masterDir ?? "";
  let loaded = true;

  /* Một file hỏng → danh mục đó rỗng, loaded=false, ghi warn, KHÔNG ném: thiếu danh mục là lý do
   * để cho qua và ghi log, không phải lý do để BE không khởi động được. */
  const load = (file, read) => {
    const full = path.join(dir, file);
    try {
      return read(full);
    } catch (error) {
      loaded = false;
      logger?.warn("master.load_failed", { file: full, error: error?.message ?? String(error) });
      return [];
    }
  };

  const locationList = load("locations.csv", (f) => parseLocationsCsv(fs.readFileSync(f, "utf8")));
  const warehouseList = load("warehouses.json", readJsonArray);
  const shiftList = load("shifts.json", readJsonArray);

  /* Sắp xếp một lần lúc nạp: mọi truy vấn đều trả theo code tăng dần nên không cần sort lại. */
  locationList.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const byCode = new Map(locationList.map((l) => [l.code, l]));

  logger?.info("master.loaded", {
    dir,
    locations: locationList.length,
    warehouses: warehouseList.length,
    shifts: shiftList.length,
    loaded,
  });

  return {
    locations({ q, limit = 50, includeInactive = false } = {}) {
      const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
      const matched = locationList.filter((l) => {
        if (!includeInactive && !l.active) return false;
        if (!needle) return true;
        return l.code.toLowerCase().includes(needle) || l.zone.toLowerCase().includes(needle);
      });
      const max = Number.isFinite(limit) ? Math.trunc(limit) : 50;
      /* total đếm TRƯỚC khi cắt theo limit: FE cần biết còn bao nhiêu mã nữa ngoài trang này. */
      return { items: matched.slice(0, Math.max(0, max)), total: matched.length };
    },

    warehouses() {
      return warehouseList.map((w) => ({ code: w.code, name: w.name, active: w.active === true }));
    },

    shifts() {
      return shiftList.map((s) => ({ code: s.code, name: s.name, startsAt: s.startsAt, endsAt: s.endsAt }));
    },

    /* FAIL-OPEN (Q28): danh mục chưa nạp được hoặc rỗng → không chặn ai. Có danh mục thì mới kiểm.
     * So khớp CHÍNH XÁC, phân biệt hoa thường — giá trị đã được validateReceiptData chuẩn hoá về
     * chữ hoa trước khi tới đây. */
    hasLocation(code) {
      if (!loaded || locationList.length === 0) return true;
      /* active=false nghĩa là vị trí đang bị khoá/ngừng dùng: GET /api/master/locations không
       * bao giờ chào nó, nên nhận phiếu vào nó là nhận một mã mà giao diện coi như không tồn
       * tại. Xử như ngoài danh mục (422 LOCATION_UNKNOWN), gợi ý thì chỉ có mã đang hoạt động. */
      return byCode.get(code)?.active === true;
    },

    /* Gợi ý tất định: cùng ký tự đầu, đang hoạt động, code nhỏ nhất trước. Không khớp → [] */
    suggestLocations(code, max = 3) {
      const value = typeof code === "string" ? code.trim() : "";
      if (!value) return [];
      const first = value[0].toLowerCase();
      const n = Number.isFinite(max) ? Math.trunc(max) : 3;
      if (n <= 0) return [];
      const out = [];
      for (const l of locationList) {
        if (!l.active) continue;
        if (l.code[0]?.toLowerCase() !== first) continue;
        out.push(l.code);
        if (out.length === n) break;
      }
      return out;
    },

    /* Cả ba file nạp được thì mới là true. Một file hỏng → fail-open cho toàn bộ danh mục: thà
     * cho qua và ghi log còn hơn chặn nhập hàng vì một file CSV. */
    loaded,
  };
}
