import assert from "node:assert/strict";
import { test } from "node:test";
import {
  frozenManifestSchema,
  runtimeEnvironmentCapabilitiesSchema,
  runtimeEnvironmentGetParamsSchema,
  runtimeEnvironmentPrepareParamsSchema,
  runtimeEnvironmentRecordSchema,
} from "@lcode/shared";

test("prepare params reject unknown fields (strict protocol)", () => {
  assert.throws(() =>
    runtimeEnvironmentPrepareParamsSchema.parse({
      workspacePath: "C:/proj",
      requestId: "req-1",
      purpose: "worktree",
      unexpectedField: true,
    }),
  );
});

test("get params require environmentId or requestId", () => {
  assert.throws(() => runtimeEnvironmentGetParamsSchema.parse({ workspacePath: "C:/proj" }));
  assert.doesNotThrow(() =>
    runtimeEnvironmentGetParamsSchema.parse({ workspacePath: "C:/proj", requestId: "req-1" }),
  );
});

test("capabilities without managedEnvironments must carry missingReason", () => {
  assert.throws(() => runtimeEnvironmentCapabilitiesSchema.parse({ managedEnvironments: false }));
  assert.doesNotThrow(() =>
    runtimeEnvironmentCapabilitiesSchema.parse({
      managedEnvironments: false,
      missingReason: "host-not-supported",
    }),
  );
});

test("frozen manifest rejects unknown schemaVersion", () => {
  const base = {
    backendVersion: "v2026.10.2",
    os: "windows" as const,
    arch: "x64" as const,
    tools: [],
    declarationDigest: "a".repeat(16),
    installStrategy: "frozen" as const,
    createdAt: "2026-10-05T00:00:00.000Z",
  };
  assert.throws(() => frozenManifestSchema.parse({ ...base, schemaVersion: 2 }));
  assert.doesNotThrow(() => frozenManifestSchema.parse({ ...base, schemaVersion: 1 }));
});

test("environment record rejects corrupt scope and unknown status", () => {
  const base = {
    environmentId: "a".repeat(32),
    scope: { workspacePath: "C:/proj" },
    purpose: "worktree" as const,
    currentRevision: 1,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
  assert.throws(() =>
    runtimeEnvironmentRecordSchema.parse({ ...base, status: "made-up" }),
  );
  assert.throws(() =>
    runtimeEnvironmentRecordSchema.parse({
      ...base,
      status: "ready",
      scope: { workspacePath: "" },
    }),
  );
  assert.doesNotThrow(() => runtimeEnvironmentRecordSchema.parse({ ...base, status: "ready" }));
});
