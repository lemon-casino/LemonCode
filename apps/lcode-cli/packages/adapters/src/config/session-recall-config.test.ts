import assert from "node:assert/strict";
import test from "node:test";
import { ConfigKey, DefaultRuntimeConfig } from "@lcode/contracts";
import { createConfigPort, LCodeConfigFileSchema } from "./index.js";

test("session recall config is default-off and independently configurable", () => {
  assert.equal(DefaultRuntimeConfig.sessionRecall.enabled, false);

  const defaults = createConfigPort();
  assert.equal(defaults.get(ConfigKey.SessionRecallEnabled), false);
  assert.equal(defaults.getAll().sessionRecall.enabled, false);

  const enabled = createConfigPort({
    features: { memory: false },
    memory: { use: false },
    sessionRecall: { enabled: true },
  });
  assert.equal(enabled.get(ConfigKey.SessionRecallEnabled), true);
  assert.equal(enabled.getAll().features.memory, false);
  assert.equal(enabled.getAll().memory.use, false);
  assert.equal(enabled.getAll().sessionRecall.enabled, true);

  assert.deepEqual(LCodeConfigFileSchema.parse({ sessionRecall: { enabled: true } }), {
    sessionRecall: { enabled: true },
  });
});
