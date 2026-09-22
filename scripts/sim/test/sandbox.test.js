import test from "node:test";
import assert from "node:assert/strict";
import { parseSandboxArgs, serverEnvFor, envSignature } from "../sandbox.js";

test("--recognition-mode chỉ nhận sync hoặc async, giá trị khác bị NÉM chứ không im lặng bỏ qua", () => {
  assert.equal(parseSandboxArgs(["--recognition-mode", "async"]).recognitionMode, "async");
  assert.equal(parseSandboxArgs(["--recognition-mode=sync"]).recognitionMode, "sync");
  assert.equal(parseSandboxArgs([]).recognitionMode, null);
  assert.throws(() => parseSandboxArgs(["--recognition-mode", "asycn"]), /sync hoặc async.*asycn/s);
});

test("serverEnvFor: serverEnv của kịch bản THẮNG --env và --recognition-mode, vì đó là điều kiện để kịch bản còn đo được gì", () => {
  const values = { env: { LOG_LEVEL: "debug", RECOGNITION_MODE: "sync" }, recognitionMode: "sync" };
  const scenario = { serverEnv: { RECOGNITION_MODE: "async", RECOGNITION_MAX_CONCURRENT: "2" } };

  const merged = serverEnvFor(values, scenario);
  assert.equal(merged.RECOGNITION_MODE, "async", "kịch bản async không được chạy ở chế độ sync");
  assert.equal(merged.RECOGNITION_MAX_CONCURRENT, "2");
  // Biến không tranh chấp thì vẫn giữ nguyên của người gõ lệnh.
  assert.equal(merged.LOG_LEVEL, "debug");

  // Kịch bản không đòi gì → chỉ còn cấu hình của người gõ lệnh.
  assert.deepEqual(serverEnvFor({ env: {}, recognitionMode: "async" }, { name: "x" }), { RECOGNITION_MODE: "async" });
  assert.deepEqual(serverEnvFor({ env: {}, recognitionMode: null }, { name: "x" }), {});
});

test("envSignature bằng nhau khi hai bộ biến giống nhau dù khác thứ tự, và khác nhau khi một giá trị đổi", () => {
  /* Chữ ký này quyết định hộp cát có DỰNG LẠI máy chủ hay không. Sai ở đây nghĩa là chạy
   * kịch bản async trên máy chủ sync còn sót lại từ kịch bản trước. */
  assert.equal(
    envSignature({ RECOGNITION_MODE: "async", LOG_LEVEL: "warn" }),
    envSignature({ LOG_LEVEL: "warn", RECOGNITION_MODE: "async" }),
  );
  assert.notEqual(envSignature({ RECOGNITION_MODE: "async" }), envSignature({ RECOGNITION_MODE: "sync" }));
  assert.notEqual(envSignature({}), envSignature({ RECOGNITION_MODE: "async" }));
});
