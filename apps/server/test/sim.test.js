import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, upload, getJson, postJson, putJson, delJson, receiptBody, JPEG, DEVICE_A, DEVICE_B } from "./helpers.js";
import { mergeScenario, validateScenarioPatch, SIM_DEFAULT } from "../src/sim/engine.js";

const dev = (id) => ({ "x-device-id": id });

test("PUT /api/admin/sim backend.mode=down → mọi route 503 BACKEND_DOWN_SIMULATED, TRỪ /api/status và /api/admin/*", async () => {
  const t = await startTestApp();
  try {
    assert.equal((await putJson(t.base, "/api/admin/sim", { backend: { mode: "down" } })).status, 200);

    for (const path of ["/api/health", "/api/receipts", "/api/devices"]) {
      const r = await getJson(t.base, path);
      assert.equal(r.status, 503, `${path} phải bị chặn`);
      assert.equal(r.body.error.code, "BACKEND_DOWN_SIMULATED");
      assert.equal(r.body.error.message, "Mô phỏng: máy chủ đang ngừng hoạt động");
      assert.deepEqual(r.body.error.details, { retryAfterMs: 5000, simulated: true });
      assert.equal(r.headers.get("retry-after"), "5");
      assert.ok(r.headers.get("x-request-id"), "response bị chặn vẫn phải có x-request-id");
    }
    assert.equal((await postJson(t.base, "/api/receipts", receiptBody("req-down-000001"))).status, 503);

    // Đường sống của PDA và đường thoát hiểm của người vận hành không bao giờ bị chặn.
    const status = await getJson(t.base, "/api/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.backend.state, "down");
    assert.equal(status.body.backend.simulated, true);
    assert.equal((await getJson(t.base, "/api/admin/sim")).status, 200);
    assert.equal((await delJson(t.base, "/api/admin/sim")).status, 200);
    assert.equal((await getJson(t.base, "/api/health")).status, 200, "xoá kịch bản là hết chặn ngay");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("backend.mode=readonly → POST/PUT/DELETE 503 BACKEND_READONLY, GET vẫn 200", async () => {
  const t = await startTestApp();
  try {
    await putJson(t.base, "/api/admin/sim", { backend: { mode: "readonly" } });

    const read = await getJson(t.base, "/api/receipts");
    assert.equal(read.status, 200);
    assert.equal((await getJson(t.base, "/api/health")).status, 200);

    const write = await postJson(t.base, "/api/receipts", receiptBody("req-readonly-0001"));
    assert.equal(write.status, 503);
    assert.equal(write.body.error.code, "BACKEND_READONLY");
    assert.equal(write.body.error.message, "Mô phỏng: máy chủ đang ở chế độ chỉ đọc, không ghi được");
    assert.deepEqual(write.body.error.details, { retryAfterMs: 5000, simulated: true });
    assert.equal(write.headers.get("retry-after"), "5");

    assert.equal((await postJson(t.base, "/api/devices/register", { deviceId: DEVICE_A })).status, 503);
    const st = await getJson(t.base, "/api/status");
    assert.equal(st.body.backend.state, "readonly");
    assert.equal(st.body.backend.readonly, true);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("backend.mode=degraded latencyMs=400 → response chậm ≥ 400 ms; /api/admin/* KHÔNG bị chậm", async () => {
  const t = await startTestApp();
  try {
    await putJson(t.base, "/api/admin/sim", { backend: { mode: "degraded", latencyMs: 400 } });

    const t0 = Date.now();
    const health = await getJson(t.base, "/api/health");
    const slow = Date.now() - t0;
    assert.equal(health.status, 200);
    assert.ok(slow >= 400, `phải chậm ≥ 400 ms, đo được ${slow} ms`);

    const t1 = Date.now();
    const admin = await getJson(t.base, "/api/admin/sim");
    const fast = Date.now() - t1;
    assert.equal(admin.status, 200);
    assert.ok(fast < 400, `/api/admin/* miễn trừ latency, đo được ${fast} ms`);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("SIM_OVERRIDE=false → cả 5 endpoint /api/admin/sim trả 403 SIM_DISABLED, và sim middleware không chặn gì", async () => {
  // Đặt kịch bản down khi còn bật, rồi khởi động lại với SIM_OVERRIDE=false trên cùng dataDir.
  const on = await startTestApp();
  const dataDir = on.dataDir;
  await putJson(on.base, "/api/admin/sim", { backend: { mode: "down" } });
  await on.stop();

  const t = await startTestApp({ simOverride: false }, { dataDir });
  try {
    const calls = [
      await getJson(t.base, "/api/admin/sim"),
      await putJson(t.base, "/api/admin/sim", { backend: { mode: "normal" } }),
      await delJson(t.base, "/api/admin/sim"),
      await putJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`, { ocr: { mode: "error" } }),
      await delJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`),
    ];
    for (const r of calls) {
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, "SIM_DISABLED");
      assert.equal(r.body.error.message, "Mô phỏng đang tắt (SIM_OVERRIDE=false)");
    }

    // Kịch bản down đã lưu trong DB không được áp khi mô phỏng tắt.
    assert.equal((await getJson(t.base, "/api/health")).status, 200);
    const st = await getJson(t.base, "/api/status");
    assert.equal(st.body.sim.enabled, false);
    assert.equal(st.body.sim.scope, "none");
    assert.equal(st.body.sim.global, null);
    assert.equal(st.body.sim.device, null);
    assert.equal(st.body.sim.updatedAt, null);
    assert.equal(st.body.backend.state, "up");
    assert.deepEqual(st.body.sim.effective, SIM_DEFAULT);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("PUT sim: key lạ, mode ngoài enum, latencyMs ngoài 0..30000 → 400 INVALID_SIM_CONFIG kèm details", async () => {
  const t = await startTestApp();
  try {
    const unknownTop = await putJson(t.base, "/api/admin/sim", { foo: 1 });
    assert.equal(unknownTop.status, 400);
    assert.equal(unknownTop.body.error.code, "INVALID_SIM_CONFIG");
    assert.equal(unknownTop.body.error.message, "Kịch bản mô phỏng không hợp lệ");
    assert.deepEqual(unknownTop.body.error.details.unknownKeys, ["foo"]);

    const unknownNested = await putJson(t.base, "/api/admin/sim", { ocr: { speed: 1 } });
    assert.deepEqual(unknownNested.body.error.details.unknownKeys, ["ocr.speed"]);

    const badEnum = await putJson(t.base, "/api/admin/sim", { backend: { mode: "explode" } });
    assert.equal(badEnum.status, 400);
    assert.equal(badEnum.body.error.details.field, "backend.mode");
    assert.deepEqual(badEnum.body.error.details.allowed, ["normal", "degraded", "readonly", "down"]);

    const badRange = await putJson(t.base, "/api/admin/sim", { ocr: { delayMs: 999999 } });
    assert.equal(badRange.status, 400);
    assert.equal(badRange.body.error.details.field, "ocr.delayMs");
    assert.deepEqual(badRange.body.error.details.range, [0, 30000]);

    const notInteger = await putJson(t.base, "/api/admin/sim", { save: { latencyMs: 1.5 } });
    assert.equal(notInteger.body.error.details.field, "save.latencyMs");

    const notObject = await putJson(t.base, "/api/admin/sim", [1, 2]);
    assert.equal(notObject.body.error.details.reason, "body_not_object");

    // Body rỗng là hợp lệ: không đổi gì, trả trạng thái hiện tại.
    const empty = await putJson(t.base, "/api/admin/sim", {});
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.default, SIM_DEFAULT);
    assert.deepEqual(empty.body.global, SIM_DEFAULT);

    // Hàm validate thuần cũng phải nói đúng như vậy.
    assert.equal(validateScenarioPatch({ ocr: { mode: "garbage" } }).ok, true);
    assert.equal(validateScenarioPatch({ ocr: { mode: "nope" } }).ok, false);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("kịch bản theo device chỉ ảnh hưởng device đó: device A ocr.mode=error → 502, device B vẫn 201", async () => {
  const t = await startTestApp();
  try {
    const put = await putJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`, { ocr: { mode: "error" } });
    assert.equal(put.status, 200);
    assert.equal(put.body.deviceId, DEVICE_A);
    assert.equal(put.body.deviceKnown, false, "device chưa đăng ký vẫn đặt trước được kịch bản");
    assert.deepEqual(put.body.device, { ocr: { mode: "error" } });
    assert.equal(put.body.effectiveForDevice.ocr.mode, "error");

    const a = await upload(t.base, JPEG, { headers: dev(DEVICE_A) });
    assert.equal(a.status, 502);
    assert.equal(a.body.error.code, "RECOGNITION_FAILED");

    const b = await upload(t.base, JPEG, { headers: dev(DEVICE_B) });
    assert.equal(b.status, 201);

    const anonymous = await upload(t.base, JPEG);
    assert.equal(anonymous.status, 201, "không có x-device-id thì không dính kịch bản của device");

    // Xoá kịch bản của device → trở lại bình thường; device chưa có dòng nào vẫn 200.
    assert.equal((await delJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`)).body.cleared, "device");
    assert.equal((await upload(t.base, JPEG, { headers: dev(DEVICE_A) })).status, 201);
    assert.equal((await delJson(t.base, `/api/admin/sim/devices/${DEVICE_B}`)).status, 200);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("trộn kịch bản theo field: global {ocr:{delayMs:300}} + device {ocr:{mode:\"error\"}} → effective giữ cả delayMs lẫn mode", async () => {
  // Hàm thuần trước: thuật toán trộn là hợp đồng chung của cả BE lẫn FE.
  const merged = mergeScenario({ ocr: { delayMs: 300 } }, { ocr: { mode: "error" } });
  assert.deepEqual(merged.ocr, { mode: "error", delayMs: 300 });
  assert.deepEqual(merged.backend, SIM_DEFAULT.backend);
  assert.deepEqual(mergeScenario({ ocr: { mode: null } }).ocr, { mode: "success", delayMs: 0 }, "null không ghi đè");

  const t = await startTestApp();
  try {
    await putJson(t.base, "/api/admin/sim", { ocr: { delayMs: 300 } });
    await putJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`, { ocr: { mode: "error" } });

    const st = await getJson(t.base, "/api/status", dev(DEVICE_A));
    assert.deepEqual(st.body.sim.effective.ocr, { mode: "error", delayMs: 300 });
    assert.deepEqual(st.body.sim.global.ocr, { mode: "success", delayMs: 300 }, "global giữ nguyên, không bị device ghi đè");

    const admin = await getJson(t.base, "/api/admin/sim");
    assert.deepEqual(admin.body.devices, { [DEVICE_A]: { ocr: { mode: "error" } } });
    assert.deepEqual(admin.body.default, SIM_DEFAULT);
    assert.ok(admin.body.updatedAt);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("ocr.mode=partial → 3 trường partNumber/shipmentDate/supplier có status missing, các trường khác giữ nguyên", async () => {
  const t = await startTestApp();
  try {
    const normal = (await upload(t.base, JPEG)).body;
    assert.equal(normal.fields.partNumber.status, "ok");

    await putJson(t.base, "/api/admin/sim", { ocr: { mode: "partial" } });
    const { status, body } = await upload(t.base, JPEG);
    assert.equal(status, 201);
    for (const key of ["partNumber", "shipmentDate", "supplier"]) {
      assert.equal(body.fields[key].status, "missing", `${key} phải missing`);
      assert.equal(body.fields[key].value, null);
      assert.equal(body.fields[key].raw, null);
    }
    assert.equal(body.fields.partName.status, "ok");
    assert.equal(body.fields.partName.value, normal.fields.partName.value);
    assert.equal(body.fields.quantity.value, 80);
    assert.equal(body.fieldsFound, normal.fieldsFound - 3);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("ocr.mode=garbage → partNumber status ok nhưng confidence ≤ 0.5, partName ok, quantity unparsed (ĐÍNH CHÍNH R1)", async () => {
  const t = await startTestApp();
  try {
    await putJson(t.base, "/api/admin/sim", { ocr: { mode: "garbage" } });
    const garbage = (await upload(t.base, JPEG)).body;
    /* Giá trị rác đi thẳng vào bộ chuẩn hoá thật, không có nhánh riêng cho sim. Bảng kết quả
     * đúng nằm ở ĐÍNH CHÍNH R1 của 01-contracts.md §6.5: coerce() kiểu "code" luôn ok=true
     * (giữ chuỗi cho người vận hành sửa tay), sai PART_NUMBER_RE chỉ bị kẹp confidence ≤ 0.5. */
    assert.equal(garbage.fields.partNumber.status, "ok", "mã sai định dạng vẫn ok, KHÔNG phải unparsed");
    assert.equal(garbage.fields.partNumber.value, "X#@!9-??");
    assert.equal(garbage.fields.partNumber.raw, "X#@!9-??");
    assert.ok(garbage.fields.partNumber.confidence <= 0.5, "mã sai định dạng bị kẹp confidence ≤ 0.5");

    assert.equal(garbage.fields.partName.status, "ok", "text không có pattern nên vẫn ok");
    assert.equal(garbage.fields.partName.value, "▒▒▒ĐỌC KHÔNG RA▒▒▒");
    assert.equal(garbage.fields.partName.raw, "▒▒▒ĐỌC KHÔNG RA▒▒▒");

    assert.equal(garbage.fields.quantity.status, "unparsed", '"??" không ép được sang integer');
    assert.equal(garbage.fields.quantity.value, null);
    assert.equal(garbage.fields.quantity.raw, "??");
    assert.equal(garbage.fields.quantity.confidence, 0);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("ocr.mode=lowConfidence → mọi trường CÓ MẶT trong kết quả provider có confidence 0.3; trường missing/unparsed vẫn 0 (§6.2)", async () => {
  const t = await startTestApp();
  try {
    await putJson(t.base, "/api/admin/sim", { ocr: { mode: "lowConfidence" } });
    const low = (await upload(t.base, JPEG)).body;

    const okFields = Object.entries(low.fields).filter(([, f]) => f.status === "ok");
    assert.ok(okFields.length > 0);
    for (const [key, f] of okFields) assert.equal(f.confidence, 0.3, `${key} phải có confidence 0.3`);

    /* §6.2 nói "mọi trường CÓ MẶT trong kết quả" — wrapper đặt 0.3 trước khi chuẩn hoá, nên
     * trường provider không trả (missing) chưa bao giờ nhận 0.3, còn trường không ép được kiểu
     * (unparsed) bị chuẩn hoá hạ về 0. */
    const notOk = Object.entries(low.fields).filter(([, f]) => f.status !== "ok");
    assert.ok(notOk.length > 0, "nhãn mẫu luôn có trường provider không trả");
    for (const [key, f] of notOk) assert.equal(f.confidence, 0, `${key} không đọc được thì confidence phải là 0`);
    assert.equal(low.fields.location.status, "missing");
    assert.equal(low.fields.location.confidence, 0);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("PUT/DELETE /api/admin/sim/devices/<không phải UUID v4> → 400 INVALID_DEVICE_ID (không phải 404 NOT_FOUND)", async () => {
  const t = await startTestApp();
  try {
    for (const bad of ["khong-phai-uuid", "00000000-0000-1000-0000-000000000000", DEVICE_A.toUpperCase(), "123"]) {
      const put = await putJson(t.base, `/api/admin/sim/devices/${bad}`, { ocr: { mode: "error" } });
      assert.equal(put.status, 400, `PUT ${bad} phải là 400`);
      assert.equal(put.body.error.code, "INVALID_DEVICE_ID");
      assert.equal(put.body.error.details.deviceId, bad);

      const del = await delJson(t.base, `/api/admin/sim/devices/${bad}`);
      assert.equal(del.status, 400, `DELETE ${bad} phải là 400`);
      assert.equal(del.body.error.code, "INVALID_DEVICE_ID");
    }

    // Id hợp lệ vẫn đi đúng đường cũ.
    assert.equal((await putJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`, { ocr: { mode: "error" } })).status, 200);
    assert.equal((await delJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`)).status, 200);
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("?sim= và ?simSave= ưu tiên cao hơn kịch bản đã lưu; ?sim=weird vẫn 400 INVALID_SIM", async () => {
  const t = await startTestApp();
  try {
    await putJson(t.base, "/api/admin/sim", { ocr: { mode: "error" } });
    assert.equal((await upload(t.base, JPEG)).status, 502);
    assert.equal((await upload(t.base, JPEG, { query: "?sim=success" })).status, 201, "?sim= thắng kịch bản đã lưu");

    await putJson(t.base, `/api/admin/sim/devices/${DEVICE_A}`, { ocr: { mode: "error" } });
    assert.equal((await upload(t.base, JPEG, { query: "?sim=success", headers: dev(DEVICE_A) })).status, 201, "?sim= thắng cả kịch bản device");

    await putJson(t.base, "/api/admin/sim", { ocr: { mode: "success" }, save: { mode: "fail" } });
    assert.equal((await postJson(t.base, "/api/receipts", receiptBody("req-simsave-0001"))).status, 503);
    const ok = await postJson(t.base, "/api/receipts?simSave=normal", receiptBody("req-simsave-0002"));
    assert.equal(ok.status, 201, "?simSave=normal thắng save.mode=fail đã lưu");

    const weird = await upload(t.base, JPEG, { query: "?sim=weird" });
    assert.equal(weird.status, 400);
    assert.equal(weird.body.error.code, "INVALID_SIM");
    const weirdSave = await postJson(t.base, "/api/receipts?simSave=weird", receiptBody("req-simsave-0003"));
    assert.equal(weirdSave.status, 400);
    assert.equal(weirdSave.body.error.code, "INVALID_SIM");
  } finally {
    await t.stop();
    t.cleanup();
  }
});

test("save.mode=slow: chờ trước khi INSERT, nhưng bản ghi đã có (idempotent) trả về ngay", async () => {
  const t = await startTestApp();
  try {
    // Gọi thẳng service để đo được độ trễ mà không phải chờ đủ 8 s như tầng HTTP áp.
    const body = receiptBody("req-saveslow-0001");
    const t0 = Date.now();
    const created = await t.app.receipts.create(body, { simSave: "slow", saveLatencyMs: 150 });
    assert.equal(created.created, true);
    assert.ok(Date.now() - t0 >= 150, "phải chờ trước khi INSERT");

    const t1 = Date.now();
    const again = await t.app.receipts.create(body, { simSave: "slow", saveLatencyMs: 150 });
    assert.equal(again.created, false);
    assert.ok(Date.now() - t1 < 150, "kiểm idempotency TRƯỚC khi mô phỏng chậm/hỏng");

    // save.mode=fail cũng phải đứng sau idempotency: bản ghi cũ vẫn đọc lại được.
    const kept = await t.app.receipts.create(body, { simSave: "fail" });
    assert.equal(kept.created, false);
    assert.equal(kept.receipt.receiptId, created.receipt.receiptId);
  } finally {
    await t.stop();
    t.cleanup();
  }
});
