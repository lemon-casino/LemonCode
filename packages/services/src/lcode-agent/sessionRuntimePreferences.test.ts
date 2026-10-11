import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalSessionRuntimePreferences } from "./sessionRuntimePreferences.js";

test("local Host sends workspace storage explicitly but profile keeps the older wire shape", () => {
  for (const scope of ["runtime-materialization", "user-execution"] as const) {
    for (const memoryStorageLocation of [undefined, "profile"] as const)
      assert.equal(
        Object.hasOwn(
          buildLocalSessionRuntimePreferences({ memoryStorageLocation }, scope),
          "memoryStorageLocation",
        ),
        false,
      );
    assert.equal(
      buildLocalSessionRuntimePreferences(
        { memoryEnabled: false, memoryStorageLocation: "workspace" },
        scope,
      ).memoryStorageLocation,
      "workspace",
    );
  }
});

test("local preference construction preserves current feature defaults and execution-only shell", () => {
  const integratedTerminalShell = {
    mode: "shell" as const,
    id: "pwsh",
    label: "PowerShell",
    path: "pwsh",
    dialect: "powershell" as const,
  };
  const settings = {
    memoryEnabled: true,
    sessionRecallEnabled: true,
    memoryStorageLocation: "workspace" as const,
    integratedTerminalShell,
  };
  const materialized = buildLocalSessionRuntimePreferences(settings, "runtime-materialization");
  assert.equal(materialized.nativeSearchEnhancementsEnabled, true);
  assert.equal(materialized.askUserQuestionAutoResolutionEnabled, true);
  assert.equal(materialized.memoryEnabled, true);
  assert.equal(materialized.sessionRecallEnabled, true);
  assert.equal(materialized.integratedTerminalShell, undefined);
  assert.deepEqual(
    buildLocalSessionRuntimePreferences(settings, "user-execution").integratedTerminalShell,
    integratedTerminalShell,
  );
});

test("local Host freezes a positive storage revision even when switching back to profile", () => {
  for (const scope of ["runtime-materialization", "user-execution"] as const) {
    for (const memoryStorageRevision of [undefined, 0])
      assert.equal(
        Object.hasOwn(
          buildLocalSessionRuntimePreferences({ memoryStorageRevision }, scope),
          "memoryStorageRevision",
        ),
        false,
      );
    for (const memoryStorageLocation of ["profile", "workspace"] as const) {
      const preferences = buildLocalSessionRuntimePreferences(
        { memoryStorageLocation, memoryStorageRevision: 3 },
        scope,
      );
      assert.equal(preferences.memoryStorageRevision, 3);
      assert.equal(preferences.memoryStorageLocation ?? "profile", memoryStorageLocation);
    }
  }
});
