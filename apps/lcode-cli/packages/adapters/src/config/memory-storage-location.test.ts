import assert from "node:assert/strict";
import test from "node:test";
import { ConfigKey, DefaultRuntimeConfig } from "@lcode/contracts";
import { createConfigPort, LCodeConfigFileSchema } from "./index.js";

test("memory storage location defaults to profile and supports explicit workspace configuration", () => {
  assert.equal(DefaultRuntimeConfig.memory.storageLocation, "profile");
  const defaults = createConfigPort();
  assert.equal(defaults.get(ConfigKey.MemoryStorageLocation), "profile");
  assert.equal(defaults.getAll().memory.storageLocation, "profile");
  const parsed = LCodeConfigFileSchema.parse({ memory: { storageLocation: "workspace" } });
  assert.equal(createConfigPort(parsed).getAll().memory.storageLocation, "workspace");
  assert.throws(() =>
    LCodeConfigFileSchema.parse({ memory: { storageLocation: "arbitrary-path" } }),
  );
});

test("standalone CLI keeps an absent revision unversioned and rejects unsafe revision config", () => {
  const defaults = createConfigPort();
  assert.equal(defaults.getAll().memory.storageRevision, undefined);
  const parsed = LCodeConfigFileSchema.parse({ memory: { storageRevision: 3 } });
  assert.equal(createConfigPort(parsed).get(ConfigKey.MemoryStorageRevision), 3);
  assert.equal(createConfigPort(parsed).getAll().memory.storageRevision, 3);
  for (const storageRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => LCodeConfigFileSchema.parse({ memory: { storageRevision } }));
});
