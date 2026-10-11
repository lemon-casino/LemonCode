import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import { lcodeSessionRuntimePreferencesResultSchema } from "./lcode-protocol/index.js";

test("old settings default to profile and both explicit storage locations survive validation", () => {
  assert.equal(appSettingsSchema.parse({}).memoryStorageLocation, "profile");
  for (const memoryStorageLocation of ["profile", "workspace"] as const) {
    assert.deepEqual(appSettingsPatchSchema.parse({ memoryStorageLocation }), {
      memoryStorageLocation,
    });
    assert.equal(
      appSettingsSchema.parse({ memoryEnabled: false, memoryStorageLocation })
        .memoryStorageLocation,
      memoryStorageLocation,
    );
  }
});

test("invalid memory storage locations are rejected before settings persistence", () => {
  for (const memoryStorageLocation of ["", "other", "/absolute/root", null]) {
    assert.equal(appSettingsPatchSchema.safeParse({ memoryStorageLocation }).success, false);
    assert.equal(appSettingsSchema.safeParse({ memoryStorageLocation }).success, false);
  }
});

test("runtime preference wire retains profile omission and validates explicit workspace selection", () => {
  const previousHost = { nativeSearchEnhancementsEnabled: true, memoryEnabled: false };
  assert.equal(
    Object.hasOwn(
      lcodeSessionRuntimePreferencesResultSchema.parse(previousHost),
      "memoryStorageLocation",
    ),
    false,
  );
  assert.equal(
    lcodeSessionRuntimePreferencesResultSchema.parse({
      ...previousHost,
      memoryStorageLocation: "workspace",
    }).memoryStorageLocation,
    "workspace",
  );
  assert.equal(
    lcodeSessionRuntimePreferencesResultSchema.safeParse({
      ...previousHost,
      memoryStorageLocation: "external",
    }).success,
    false,
  );
});

test("storage revision defaults to zero and only nonnegative safe integers survive settings validation", () => {
  assert.equal(appSettingsSchema.parse({}).memoryStorageRevision, 0);
  for (const memoryStorageRevision of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      appSettingsSchema.parse({ memoryStorageRevision }).memoryStorageRevision,
      memoryStorageRevision,
    );
    assert.deepEqual(appSettingsPatchSchema.parse({ memoryStorageRevision }), {
      memoryStorageRevision,
    });
  }
  for (const memoryStorageRevision of [
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "1",
    null,
  ]) {
    assert.equal(appSettingsSchema.safeParse({ memoryStorageRevision }).success, false);
    assert.equal(appSettingsPatchSchema.safeParse({ memoryStorageRevision }).success, false);
  }
});

test("revision wire absence remains compatible and explicit revisions validate without changing location", () => {
  const previousHost = { nativeSearchEnhancementsEnabled: true, memoryEnabled: false };
  const legacy = lcodeSessionRuntimePreferencesResultSchema.parse(previousHost);
  assert.equal(legacy.memoryStorageRevision ?? 0, 0);
  assert.equal(Object.hasOwn(legacy, "memoryStorageRevision"), false);
  for (const memoryStorageRevision of [0, 2, Number.MAX_SAFE_INTEGER])
    assert.equal(
      lcodeSessionRuntimePreferencesResultSchema.parse({ ...previousHost, memoryStorageRevision })
        .memoryStorageRevision,
      memoryStorageRevision,
    );
  for (const memoryStorageRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      lcodeSessionRuntimePreferencesResultSchema.safeParse({
        ...previousHost,
        memoryStorageRevision,
      }).success,
      false,
    );
});
