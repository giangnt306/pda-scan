/* Điều phối N thiết bị ảo và gom thống kê.
 *
 * Fleet KHÔNG gọi process.exit và KHÔNG quyết định đạt/không đạt: nó chỉ đo. Việc chấm là của
 * expect.js, việc quyết mã thoát là của run-scenario.js. Trộn ba việc đó vào một chỗ là cách
 * chắc chắn để không ai còn kiểm được cái nào đang nói dối.
 */

import { createDevice } from "./device.js";
import { createAdminClient } from "./client.js";
import { loadImage, FALLBACK_LOCATION } from "./fixtures.js";
import { summarize } from "./stats.js";

/* Danh sách ĐÓNG các bộ đếm. bump() một tên lạ sẽ NÉM: gõ nhầm "blockd" mà im lặng cho qua
 * sẽ làm kỳ vọng counter.blocked mãi mãi bằng 0 và kịch bản mãi mãi "đạt". */
export const COUNTER_NAMES = [
  "saved",
  "idempotent",
  "duplicate",
  "invalid",
  "invalidLocation",
  "busy429",
  "blocked",
  "netError",
  "otherError",
  "saveFailed",
  "recognizeOk",
  "recognizeFailed",
  /* Hai bộ đếm CHỈ tăng trên đường bất đồng bộ. Không có chúng thì không cách nào phân biệt
   * "kịch bản đã đi qua 202 + thăm dò" với "máy chủ lặng lẽ trả 201 đồng bộ": cả hai đều
   * cho recognizeOk như nhau, và một kịch bản async chạy nhầm ở chế độ sync vẫn báo ĐẠT. */
  "recognizeAccepted202",
  "recognizePolls",
  "heartbeats",
];

export function createStats() {
  const counters = Object.fromEntries(COUNTER_NAMES.map((k) => [k, 0]));
  const saveSamples = [];
  const recognizeSamples = [];
  const requestIds = [];
  const savedAtMs = [];
  const notes = [];
  const problems = [];

  return {
    counters,
    saveSamples,
    recognizeSamples,
    requestIds,
    savedAtMs,
    notes,
    problems,
    bump(name, by = 1) {
      if (!(name in counters)) throw new Error(`Bộ đếm không hiểu: ${name}`);
      counters[name] += by;
    },
    saveMs(ms) {
      saveSamples.push(ms);
    },
    recognizeMs(ms) {
      recognizeSamples.push(ms);
    },
    /* Một phiếu = một requestId. Ghi lại ngay lúc sinh (không phải lúc lưu xong) để lần trùng
     * nào cũng lộ ra, kể cả khi phiếu bị 422 và không bao giờ tới được DB. */
    requestId(id) {
      requestIds.push(id);
    },
    savedAt(epochMs) {
      savedAtMs.push(epochMs);
    },
    note(text) {
      notes.push(text);
    },
    /* "problem" = chuyện không nằm trong kịch bản nào cả. Luôn in ra báo cáo, kể cả --quiet. */
    problem(text) {
      problems.push(text);
    },
    duplicateRequestIds() {
      const seen = new Set();
      const dups = new Set();
      for (const id of requestIds) {
        if (seen.has(id)) dups.add(id);
        seen.add(id);
      }
      return [...dups];
    },
    summary() {
      return {
        ...counters,
        saveMs: summarize(saveSamples),
        recognizeMs: summarize(recognizeSamples),
        duplicateRequestIds: this.duplicateRequestIds(),
        requestIdCount: requestIds.length,
        notes: [...notes],
        problems: [...problems],
      };
    },
  };
}

/** Chạy tối đa `limit` tác vụ song song. Không dùng thư viện ngoài, không Promise.all mù. */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = [];
  const width = Math.max(1, Math.min(limit, queue.length));
  for (let i = 0; i < width; i += 1) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

export function createFleet({ options, log = null, stats = createStats() }) {
  const image = loadImage(options.image);
  const devices = [];
  const running = [];
  let location = FALLBACK_LOCATION;
  let locationResolved = false;
  let burstDevice = null;
  let nextIndex = 0;

  /* location là trường BẮT BUỘC và phải có trong locations.csv. Lấy từ máy chủ một lần lúc
   * khởi động; hỏng thì dùng giá trị dự phòng và NÓI TO — nếu kho mẫu không có mã đó thì phiếu
   * sẽ 422 LOCATION_UNKNOWN và kịch bản báo không đạt, đúng như phải thế. */
  async function resolveLocation() {
    if (locationResolved) return location;
    locationResolved = true;
    const admin = createAdminClient(options.base, { timeoutMs: 10_000 });
    const res = await admin.get("/api/master/locations?limit=50");
    const items = Array.isArray(res.body?.items) ? res.body.items : [];
    const active = items.find((i) => i && i.active !== false && typeof i.code === "string");
    if (active) {
      location = active.code;
      return location;
    }
    log?.(`Không lấy được danh mục vị trí — dùng "${FALLBACK_LOCATION}"`);
    stats.note(`Không lấy được danh mục vị trí (HTTP ${res.status}) — dùng "${FALLBACK_LOCATION}"`);
    location = FALLBACK_LOCATION;
    return location;
  }

  function spawn(overrides = {}) {
    const index = nextIndex;
    nextIndex += 1;
    const device = createDevice({
      index,
      options: { ...options, ...overrides },
      image,
      location,
      stats,
      log,
    });
    devices.push(device);
    return device;
  }

  return {
    stats,
    get devices() {
      return devices;
    },
    get location() {
      return location;
    },
    resolveLocation,

    /**
     * Khởi động một đội thiết bị. KHÔNG chặn: trả về ngay, các thiết bị chạy nền.
     * Độ lệch khởi động i*200 ms để 10 thiết bị không đăng ký trong cùng một mili-giây —
     * đăng ký đồng thời che mất bug đếm thật ở phía máy chủ.
     */
    async start(overrides = {}) {
      await resolveLocation();
      const count = overrides.devices ?? options.devices;
      const started = [];
      for (let i = 0; i < count; i += 1) {
        const device = spawn(overrides);
        started.push(device);
        running.push({ device, promise: device.run({ startDelayMs: i * 200 }) });
      }
      return started;
    },

    /** Chờ tất cả thiết bị chạy xong vòng lặp (chỉ có ý nghĩa khi đã gọi stop hoặc hết giờ). */
    async waitIdle() {
      await Promise.all(running.map((r) => r.promise));
    },

    /**
     * Bắn `count` upload ảnh với tối đa `concurrency` cái đồng thời.
     * Dùng một thiết bị riêng: burst là phép thử semaphore của máy chủ, không phải hành vi
     * thường ngày của một PDA, nên nó không được làm nhiễu bộ đếm phiếu của đội đang chạy.
     */
    async burst({ count = 1, concurrency = 1 } = {}) {
      await resolveLocation();
      if (!burstDevice) {
        burstDevice = spawn({ rate: 0, prefix: `${options.prefix}B` });
        running.push({ device: burstDevice, promise: burstDevice.run({ startDelayMs: 0 }) });
        // Đợi thiết bị burst đăng ký và mở phiên xong trước khi bắn.
        const until = Date.now() + 15_000;
        while (Date.now() < until && !burstDevice.sessionId && !options.noSession) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const jobs = Array.from({ length: count }, (_, i) => i);
      await pool(jobs, concurrency, async () => {
        await burstDevice.recognizeOnce();
      });
    },

    /** Dừng mọi thiết bị (kể cả thiết bị burst) và kết mọi phiên đã mở. */
    async stop({ prefix = null } = {}) {
      const targets = prefix ? devices.filter((d) => d.name.startsWith(prefix)) : devices;
      await Promise.all(targets.map((d) => d.stop()));
      await Promise.all(running.map((r) => r.promise));
    },
  };
}
