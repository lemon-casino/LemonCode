import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { DefaultRuntimeConfig } from "@lcode/contracts";
import type { ConfigResult } from "@lcode/adapters/config";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import type { LCodeAppOptions } from "./types.js";

test("runtime storage location respects Host override and startup logs describe the actual root", () => {
  for (const configLocation of ["profile", "workspace"] as const) {
    for (const override of [undefined, "profile", "workspace"] as const) {
      const runtimeConfig = resolveAppRuntimeConfig({
        cliStorageRoot: resolve("storage-fixture"),
        configResult: {
          config: {
            ...DefaultRuntimeConfig,
            memory: { use: true, storageLocation: configLocation },
          },
        } as ConfigResult,
        options: {
          runtimeConfig: override ? { memory: { storageLocation: override } } : undefined,
        } as LCodeAppOptions,
        subagentOutputRootDir: resolve("storage-fixture", "agents"),
        workingDirectory: resolve("workspace-fixture"),
      }).runtimeConfig;
      const expected = override ?? configLocation;
      assert.equal(runtimeConfig.memory?.storageLocation, expected);
      const log = runtimeConfigLogContext(runtimeConfig, resolve("workspace-fixture"));
      assert.equal(log.memoryStorageLocation, expected);
      if (expected === "workspace")
        assert.equal(log.memoryRoot, resolve("workspace-fixture", ".lcode", "memory"));
      else assert.match(log.memoryRoot!, /memories[\\/]projects/u);
    }
  }
});

test("runtime passes storage policy revision without versioning standalone defaults", () => {
  for (const configRevision of [undefined, 2]) {
    for (const hostRevision of [undefined, 0, 3]) {
      const runtime = resolveAppRuntimeConfig({
        cliStorageRoot: resolve("storage-fixture"),
        configResult: {
          config: {
            ...DefaultRuntimeConfig,
            memory: { use: true, storageRevision: configRevision },
          },
        } as ConfigResult,
        options: {
          runtimeConfig:
            hostRevision === undefined ? undefined : { memory: { storageRevision: hostRevision } },
        } as LCodeAppOptions,
        subagentOutputRootDir: resolve("storage-fixture", "agents"),
        workingDirectory: resolve("workspace-fixture"),
      }).runtimeConfig;
      assert.equal(runtime.memory?.storageRevision, hostRevision ?? configRevision);
      assert.equal(
        runtimeConfigLogContext(runtime, resolve("workspace-fixture")).memoryStorageRevision,
        hostRevision ?? configRevision,
      );
    }
  }
});
