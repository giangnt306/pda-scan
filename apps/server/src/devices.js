/* Tầng thiết bị: mỗi cài đặt webapp trên một trình duyệt là một "device" có UUID v4 do FE sinh.
 * Server không bao giờ tin đồng hồ của PDA: mọi mốc thời gian ở đây do server sinh. */

export const DEVICE_ONLINE_MS = 45_000;
export const DEVICE_STALE_MS = 300_000;
export const NETWORKS = new Set(["wifi", "cellular", "ethernet", "offline", "unknown"]);
export const META_MAX_BYTES = 4096;
export const HEARTBEAT_INTERVAL_MS = 15_000;

/* Chặt có chủ ý: crypto.randomUUID() ở cả Node lẫn browser đều sinh v4 chữ thường, nên
 * quy tắc này không gây phiền cho FE mà giúp hai đội test giống hệt nhau (Q1). */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuidV4 = (v) => typeof v === "string" && UUID_V4.test(v);
export const isDeviceId = isUuidV4;

export function deviceStatus(lastSeenIso, now = Date.now()) {
  const age = now - Date.parse(lastSeenIso);
  if (!Number.isFinite(age)) return "offline";
  if (age < DEVICE_ONLINE_MS) return "online";
  if (age < DEVICE_STALE_MS) return "stale";
  return "offline";
}

const trimOrNull = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

/* `sessions` là THAM SỐ TUỲ CHỌN (mặc định null): test cũ dựng service không truyền gì và
 * vẫn phải chạy — khi null thì `session` của mỗi item luôn null. */
export function createDeviceService({ db, logger, sessions = null }) {
  const selectOne = db.prepare("SELECT * FROM devices WHERE id = ?");
  const selectAll = db.prepare("SELECT * FROM devices ORDER BY last_seen DESC");
  const insert = db.prepare(
    `INSERT INTO devices (id, name, first_seen, last_seen, app_version, platform, last_network, screen, battery, pending_queue, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const touchStmt = db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?");
  const updateStmt = db.prepare(
    `UPDATE devices SET name=?, app_version=?, platform=?, last_network=?, screen=?, battery=?, pending_queue=?, meta=?, last_seen=?
      WHERE id=?`,
  );
  const selectActiveSession = db.prepare(
    "SELECT id FROM sessions WHERE device_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
  );
  const selectSimScopes = db.prepare("SELECT scope FROM sim_state");
  /* Dựng SẴN ngoài vòng lặp của list(): prepare trong vòng lặp là một lần biên dịch SQL cho
   * mỗi thiết bị. */
  const countReceiptsInSession = db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE session_id = ?");

  /* meta là object tuỳ ý của FE (userAgent, viewport…). Quá lớn thì bỏ hẳn thay vì cắt giữa
   * chừng — JSON cắt dở không parse lại được. */
  function serializeMeta(meta) {
    if (meta === undefined || meta === null) return null;
    if (typeof meta !== "object" || Array.isArray(meta)) return "{}";
    const json = JSON.stringify(meta);
    if (Buffer.byteLength(json) > META_MAX_BYTES) {
      logger?.warn("device.meta_too_large", { bytes: Buffer.byteLength(json) });
      return "{}";
    }
    return json;
  }

  function parseMeta(raw) {
    try {
      const v = JSON.parse(raw ?? "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  function toPublic(row, now = Date.now()) {
    return {
      id: row.id,
      name: row.name ?? null,
      appVersion: row.app_version ?? null,
      platform: row.platform ?? null,
      network: row.last_network ?? "unknown",
      screen: row.screen ?? null,
      status: deviceStatus(row.last_seen, now),
      lastSeenAgeMs: Math.max(0, now - Date.parse(row.last_seen)),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      meta: parseMeta(row.meta),
      /* Phase 5: hai cột DB đã có từ Phase 3 nhưng chưa bao giờ ra tới API — bảng thiết bị
       * của màn hình giám sát cần đúng chúng. `battery` là TỈ LỆ 0–1, không phải phần trăm
       * (QUYẾT ĐỊNH A-7): DB đã lưu 0–1 và POST /heartbeat đã nhận 0–1 từ Phase 3. */
      battery: row.battery === null || row.battery === undefined ? null : Number(row.battery),
      pendingQueue: Number(row.pending_queue ?? 0),
    };
  }

  /* Bản rút gọn 5 khoá của một phiên, đủ cho bảng thiết bị S9 và không kéo theo `summary`
   * (mỗi lần gọi sessions.get là 3 câu COUNT — quá đắt cho một danh sách). */
  const sessionBrief = (sessionId) => {
    if (!sessionId || !sessions) return null;
    const session = sessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      operator: session.operator,
      warehouse: session.warehouse,
      shift: session.shift,
      startedAt: session.startedAt,
    };
  };

  /* Ghi đè từng field: undefined = FE không gửi = giữ nguyên giá trị cũ. */
  function update(row, patch, now) {
    const next = {
      name: patch.name === undefined ? row.name : trimOrNull(patch.name, 60),
      app_version: patch.appVersion === undefined ? row.app_version : trimOrNull(patch.appVersion, 32),
      platform: patch.platform === undefined ? row.platform : trimOrNull(patch.platform, 120),
      last_network: patch.network === undefined ? row.last_network : patch.network,
      screen: patch.screen === undefined ? row.screen : trimOrNull(patch.screen, 16),
      battery: patch.battery === undefined ? row.battery : patch.battery,
      pending_queue: patch.pendingQueue === undefined ? row.pending_queue : patch.pendingQueue,
      meta: patch.meta === undefined ? row.meta : (serializeMeta(patch.meta) ?? row.meta),
    };
    updateStmt.run(
      next.name,
      next.app_version,
      next.platform,
      next.last_network,
      next.screen,
      next.battery,
      next.pending_queue,
      next.meta,
      now,
      row.id,
    );
    return selectOne.get(row.id);
  }

  return {
    toPublic,

    get(deviceId) {
      const row = selectOne.get(deviceId);
      return row ? toPublic(row) : null;
    },

    register({ deviceId, name, appVersion, platform, network, screen, meta } = {}) {
      const now = new Date().toISOString();
      const existing = selectOne.get(deviceId);
      if (existing) {
        const row = update(existing, { name, appVersion, platform, network, screen, meta }, now);
        logger?.info("device.updated", { deviceId });
        // Mốc thời gian dùng lại đúng `now` vừa ghi → lastSeenAgeMs = 0 ngay sau khi ghi.
        return { device: toPublic(row, Date.parse(now)), created: false };
      }
      insert.run(
        deviceId,
        trimOrNull(name, 60),
        now,
        now,
        trimOrNull(appVersion, 32),
        trimOrNull(platform, 120),
        network === undefined || network === null ? "unknown" : network,
        trimOrNull(screen, 16),
        null,
        0,
        serializeMeta(meta) ?? "{}",
      );
      logger?.info("device.registered", { deviceId });
      return { device: toPublic(selectOne.get(deviceId), Date.parse(now)), created: true };
    },

    /* null = thiết bị chưa đăng ký. Heartbeat cố ý KHÔNG tự đăng ký (Q3): FE cần nhận 404
     * để biết mà gọi lại /register.
     *
     * `meta` PHẢI có mặt trong chữ ký này: PDA gửi kịch bản mạng đang áp bằng
     * `meta.netSim = { mode, latencyMs, dropRate }` trong CHÍNH body heartbeat (register chỉ
     * chạy một lần lúc mở app, lúc đó chưa có kịch bản nào). Bỏ nó ở đây là làm cột «Mạng»
     * của màn hình giám sát câm vĩnh viễn — nó chỉ có đúng nguồn này. */
    heartbeat(deviceId, { appVersion, network, battery, pendingQueue, screen, meta } = {}) {
      const existing = selectOne.get(deviceId);
      if (!existing) return null;
      const now = new Date().toISOString();
      const row = update(existing, { appVersion, network, battery, pendingQueue, screen, meta }, now);
      return toPublic(row, Date.parse(now));
    },

    /* Mọi request mang x-device-id hợp lệ đều làm tươi last_seen (Q4), và tự tạo dòng nếu
     * DB bị xoá giữa ca (Q3). Không bao giờ ném lỗi: đây là việc phụ của request. */
    touch(deviceId) {
      if (!isDeviceId(deviceId)) return;
      try {
        const now = new Date().toISOString();
        const existing = selectOne.get(deviceId);
        if (existing) touchStmt.run(now, deviceId);
        else {
          insert.run(deviceId, null, now, now, null, null, "unknown", null, null, 0, "{}");
          logger?.info("device.auto_registered", { deviceId });
        }
      } catch (err) {
        logger?.warn("device.touch_failed", { deviceId, error: err?.message });
      }
    },

    list() {
      const now = Date.now();
      const simScopes = new Set(selectSimScopes.all().map((r) => r.scope));
      const counts = { total: 0, online: 0, stale: 0, offline: 0 };
      const items = selectAll.all().map((row) => {
        const pub = toPublic(row, now);
        counts.total += 1;
        counts[pub.status] += 1;
        const activeSessionId = selectActiveSession.get(row.id)?.id ?? null;
        return {
          ...pub,
          /* KHÔNG đổi, KHÔNG bỏ activeSessionId (đã có từ Phase 3): client cũ vẫn dùng nó.
           * `session` là bổ sung tiện lợi, trùng thông tin là có chủ ý. */
          activeSessionId,
          sim: { hasOverride: simScopes.has(`device:${row.id}`) },
          session: sessionBrief(activeSessionId),
          receiptsInSession: activeSessionId ? countReceiptsInSession.get(activeSessionId).n : 0,
        };
      });
      return { items, counts };
    },
  };
}

/* Kẹp về biên thay vì báo lỗi: pin 105% của một PDA rẻ tiền không đáng làm hỏng heartbeat. */
export function clampBattery(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}
