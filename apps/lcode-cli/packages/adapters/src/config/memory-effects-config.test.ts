import assert from "node:assert/strict";
import test from "node:test";
import { ConfigKey, DefaultRuntimeConfig } from "@lcode/contracts";
import { createConfigPort, LCodeConfigFileSchema } from "./index.js";

test("memory observations and ranking experiments default off and are independent opt-ins", () => {
  assert.equal(DefaultRuntimeConfig.memory.observationEnabled, false);
  assert.equal(DefaultRuntimeConfig.memory.rankingExperimentEnabled, false);
  const defaults = createConfigPort();
  assert.equal(defaults.get(ConfigKey.MemoryObservationEnabled), false);
  assert.equal(defaults.get(ConfigKey.MemoryRankingExperimentEnabled), false);
  const config = {
    memory: { use: true, observationEnabled: true, rankingExperimentEnabled: false },
  };
  assert.deepEqual(LCodeConfigFileSchema.parse(config), config);
  const enabled = createConfigPort(config);
  assert.equal(enabled.getAll().memory.observationEnabled, true);
  assert.equal(enabled.getAll().memory.rankingExperimentEnabled, false);
});
