/* Scenario engine: bật/tắt tình trạng hỏng của backend, OCR, save theo phạm vi toàn cục
 * hoặc theo từng thiết bị — không cần sửa code, không cần restart.
 *
 * sim_state lưu PATCH THÔ (chỉ key người dùng đặt), việc trộn làm lúc đọc. Nhờ vậy xoá
 * scope device là trả đúng về kịch bản global, không phải đoán lại key nào của ai. */

export const SIM_DEFAULT = {
  backend: { mode: "normal", latencyMs: 0 },
  ocr: { mode: "success", delayMs: 0 },
  save: { mode: "normal", latencyMs: 0 },
  sap: { mode: "success", latencyMs: 0 },
};

export const SIM_SECTIONS = ["backend", "ocr", "save", "sap"];

export const SIM_ENUMS = {
  "backend.mode": ["normal", "degraded", "readonly", "down"],
  "ocr.mode": ["success", "slow", "error", "timeout", "partial", "garbage", "lowConfidence"],
  "save.mode": ["normal", "fail", "slow"],
  "sap.mode": ["success", "slow", "reject", "down"],
};

export const SIM_RANGES = {
  "backend.latencyMs": [0, 30000],
  "ocr.delayMs": [0, 30000],
  "save.latencyMs": [0, 30000],
  "sap.latencyMs": [0, 30000],
};

export const SIM_KEY = "scenario";
export const GLOBAL_SCOPE = "global";
export const deviceScope = (deviceId) => `device:${deviceId}`;

/* Trộn THEO TỪNG FIELD, không theo section: đặt device {ocr:{mode}} không được xoá
 * ocr.delayMs của global. Thứ tự tham số = thứ tự ưu tiên tăng dần. */
export function mergeScenario(...sources) {
  const out = structuredClone(SIM_DEFAULT);
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const section of SIM_SECTIONS) {
      if (!src[section] || typeof src[section] !== "object") continue;
      for (const [k, v] of Object.entries(src[section])) {
        if (v !== undefined && v !== null) out[section][k] = v;
      }
    }
  }
  return out;
}

/* Gộp hai patch thô (giữ nguyên "thô": chỉ các key đã từng được đặt). */
export function mergeRawPatch(base, patch) {
  const out = base && typeof base === "object" ? structuredClone(base) : {};
  for (const section of SIM_SECTIONS) {
    if (!patch?.[section] || typeof patch[section] !== "object") continue;
    out[section] = { ...(out[section] || {}), ...patch[section] };
  }
  return out;
}

/* errors[] dùng luôn làm details của 400 INVALID_SIM_CONFIG. */
export function validateScenarioPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, errors: { reason: "body_not_object" } };
  }
  const unknownKeys = Object.keys(patch).filter((k) => !SIM_SECTIONS.includes(k));
  for (const section of SIM_SECTIONS) {
    const val = patch[section];
    if (val === undefined) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      return { ok: false, errors: { reason: "section_not_object", field: section } };
    }
    for (const key of Object.keys(val)) {
      const path = `${section}.${key}`;
      if (!SIM_ENUMS[path] && !SIM_RANGES[path]) unknownKeys.push(path);
    }
  }
  if (unknownKeys.length > 0) return { ok: false, errors: { reason: "unknown_keys", unknownKeys } };

  for (const [path, allowed] of Object.entries(SIM_ENUMS)) {
    const [section, key] = path.split(".");
    const v = patch[section]?.[key];
    if (v === undefined) continue;
    if (!allowed.includes(v)) return { ok: false, errors: { reason: "bad_enum", field: path, allowed } };
  }
  for (const [path, range] of Object.entries(SIM_RANGES)) {
    const [section, key] = path.split(".");
    const v = patch[section]?.[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < range[0] || v > range[1]) {
      return { ok: false, errors: { reason: "out_of_range", field: path, range } };
    }
  }
  return { ok: true, errors: null };
}

export function createSimEngine({ db, config, logger }) {
  const selectRow = db.prepare("SELECT json, updated_at FROM sim_state WHERE scope = ? AND key = ?");
  const selectAll = db.prepare("SELECT scope, json, updated_at FROM sim_state WHERE key = ?");
  const upsert = db.prepare(
    `INSERT INTO sim_state (scope, key, json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  );
  const del = db.prepare("DELETE FROM sim_state WHERE scope = ? AND key = ?");
  const maxUpdated = db.prepare("SELECT MAX(updated_at) AS m FROM sim_state WHERE key = ?");

  /* MOCK_MODE là mặc định của provider mock từ Phase 1 — nằm NGAY TRÊN SIM_DEFAULT trong
   * thang ưu tiên (Q7), nên kịch bản global/device/?sim= đều đè được lên nó. */
  const mockRow = () => (config.provider === "mock" ? { ocr: { mode: config.mock.mode } } : null);

  function readRaw(scope) {
    const row = selectRow.get(scope, SIM_KEY);
    if (!row) return null;
    try {
      const v = JSON.parse(row.json);
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  }

  function write(scope, patch) {
    const merged = mergeRawPatch(readRaw(scope), patch);
    const now = new Date().toISOString();
    upsert.run(scope, SIM_KEY, JSON.stringify(merged), now);
    logger?.info("sim.updated", { scope, patch: JSON.stringify(patch) });
    return merged;
  }

  return {
    get enabled() {
      return config.simOverride;
    },

    getGlobalRaw: () => readRaw(GLOBAL_SCOPE),
    getDeviceRaw: (deviceId) => (deviceId ? readRaw(deviceScope(deviceId)) : null),
    getGlobal: () => mergeScenario(readRaw(GLOBAL_SCOPE)),

    setGlobal: (patch) => write(GLOBAL_SCOPE, patch),
    setDevice: (deviceId, patch) => write(deviceScope(deviceId), patch),

    clearGlobal() {
      del.run(GLOBAL_SCOPE, SIM_KEY);
      logger?.info("sim.cleared", { scope: GLOBAL_SCOPE });
    },
    clearDevice(deviceId) {
      del.run(deviceScope(deviceId), SIM_KEY);
      logger?.info("sim.cleared", { scope: deviceScope(deviceId) });
    },

    listDevices() {
      const out = {};
      for (const row of selectAll.all(SIM_KEY)) {
        if (!row.scope.startsWith("device:")) continue;
        try {
          out[row.scope.slice("device:".length)] = JSON.parse(row.json);
        } catch {
          /* dòng hỏng thì coi như không có */
        }
      }
      return out;
    },

    updatedAt: () => maxUpdated.get(SIM_KEY).m ?? null,

    updatedAtFor(deviceId) {
      const rows = [selectRow.get(GLOBAL_SCOPE, SIM_KEY), deviceId ? selectRow.get(deviceScope(deviceId), SIM_KEY) : null];
      const times = rows.filter(Boolean).map((r) => r.updated_at);
      return times.length ? times.sort().at(-1) : null;
    },

    scopeFor(deviceId) {
      if (deviceId && readRaw(deviceScope(deviceId))) return "device";
      if (readRaw(GLOBAL_SCOPE)) return "global";
      return "none";
    },

    /* Khi tắt mô phỏng: chỉ còn mặc định + MOCK_MODE. Không đọc sim_state, không nhận
     * request override — đúng như SIM_OVERRIDE=false phải làm. */
    effective({ deviceId = null, requestOverride = null } = {}) {
      if (!config.simOverride) return mergeScenario(mockRow());
      return mergeScenario(mockRow(), readRaw(GLOBAL_SCOPE), deviceId ? readRaw(deviceScope(deviceId)) : null, requestOverride);
    },
  };
}
