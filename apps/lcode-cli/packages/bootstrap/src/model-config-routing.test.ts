import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createRuntimeAiSdkModelExecutionConfig } from "./model-config.js";
test("XQP-11 bootstrap shares the existing data directory and its legacy alias without IO", () => {
  const base = process.cwd();
  const expected = join(base, ".lcode", "v2", "routing-quotas-v1");
  assert.equal(
    createRuntimeAiSdkModelExecutionConfig({ LCODE_DATA_BASE_DIR: base }).routingQuotaDirectory,
    expected,
  );
  assert.equal(
    createRuntimeAiSdkModelExecutionConfig({ ZCODE_DATA_BASE_DIR: base }).routingQuotaDirectory,
    expected,
  );
});
