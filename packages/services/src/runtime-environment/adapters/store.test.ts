import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeEnvironmentStore } from "./store.js";
import { environmentIdFor, operationIdFor } from "../app/ports.js";
import { createRuntimeEnvironmentServiceForTests } from "../node.js";
import type { IRuntimeEnvironmentService } from "../contract.js";
import type { ProjectDeclarations } from "../domain/declarations.js";
import type { DeclarationReaderPort, ToolBackendPort } from "../app/ports.js";
import type { RuntimeEnvironmentStore } from "./store.js";

async function withTempDir<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "lcode-runtime-env-"));
  try {
    return await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function memoryDeclarations(declarations: Partial<ProjectDeclarations>): DeclarationReaderPort {
  return {
    read: async () => ({
      tools: [],
      lockfiles: [],
      ambiguousLocks: false,
      issues: [],
      ...declarations,
    }),
  };
}

function fakeBackend(
  overrides: Partial<ToolBackendPort> = {},
): ToolBackendPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureBackend: async () => {
      calls.push("ensureBackend");
      return "/fake/mise";
    },
    installTool: async (params: { key: string; version: string }) => {
      calls.push(`install:${params.key}@${params.version}`);
      return { toolPath: `/fake/tools/${params.key}-${params.version}` };
    },
    probeBackend: async () => ({ available: true }),
    ...overrides,
  };
}

const SCOPE = { workspacePath: "C:/proj", workspaceIdentity: "ident-1" };

function createService(
  store: RuntimeEnvironmentStore,
  backend: ToolBackendPort,
  declarations: DeclarationReaderPort,
): IRuntimeEnvironmentService {
  return createRuntimeEnvironmentServiceForTests({
    store,
    backend,
    declarations,
    now: () => new Date("2026-10-05T00:00:00Z"),
  });
}

test("prepare walks to ready with frozen manifest and installed tool paths", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const backend = fakeBackend();
    const service = createService(
      store,
      backend,
      memoryDeclarations({
        tools: [{ key: "node", constraint: "24.14.0", exact: true, source: "mise.toml" }],
      }),
    );
    const operation = await service.prepare({
      ...SCOPE,
      requestId: "req-1",
      purpose: "worktree",
    });
    assert.equal(operation.status, "succeeded");
    assert.deepEqual(backend.calls, ["install:node@24.14.0", "install:pnpm@10.33.2"]);
    const projection = await service.get({
      ...SCOPE,
      environmentId: operation.environmentId,
    });
    assert.equal(projection?.status, "ready");
    assert.equal(projection?.tools[0]?.source, "project-declaration");
    assert.ok(projection?.tools[0]?.toolPath?.includes("node-24.14.0"));
  });
});

test("no declarations freeze app-default tools", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const service = createService(store, fakeBackend(), memoryDeclarations({}));
    const operation = await service.prepare({
      ...SCOPE,
      requestId: "req-2",
      purpose: "worktree",
    });
    assert.equal(operation.status, "succeeded");
    const projection = await service.get({
      ...SCOPE,
      environmentId: operation.environmentId,
    });
    assert.deepEqual(
      projection?.tools.map((tool) => [tool.key, tool.version, tool.source]),
      [
        ["node", "24.14.0", "app-default"],
        ["pnpm", "10.33.2", "app-default"],
      ],
    );
  });
});

test("same requestId reuses operation without re-installing (idempotent retry)", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const backend = fakeBackend();
    const service = createService(store, backend, memoryDeclarations({}));
    const first = await service.prepare({ ...SCOPE, requestId: "req-3", purpose: "worktree" });
    const second = await service.prepare({ ...SCOPE, requestId: "req-3", purpose: "worktree" });
    assert.equal(second.operationId, first.operationId);
    assert.deepEqual(backend.calls.filter((call) => call.startsWith("install:")), [
      "install:node@24.14.0",
      "install:pnpm@10.33.2",
    ]);
  });
});

test("cancel before record persists cancelled settlement; later prepare returns it (no revival)", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const backend = fakeBackend();
    const service = createService(store, backend, memoryDeclarations({}));
    const cancelled = await service.prepare({
      ...SCOPE,
      requestId: "req-4",
      purpose: "worktree",
      cancel: true,
    });
    assert.equal(cancelled.status, "cancelled");
    const again = await service.prepare({ ...SCOPE, requestId: "req-4", purpose: "worktree" });
    assert.equal(again.status, "cancelled");
    assert.deepEqual(backend.calls, []);
  });
});

test("declaration conflict fails with structured error, no tools installed", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const backend = fakeBackend();
    const service = createService(
      store,
      backend,
      memoryDeclarations({
        issues: [
          {
            code: "configuration-conflict",
            source: "mise.toml",
            field: "node",
            message: "node 版本冲突",
          },
        ],
      }),
    );
    const operation = await service.prepare({ ...SCOPE, requestId: "req-5", purpose: "worktree" });
    assert.equal(operation.status, "failed");
    assert.equal(operation.error?.code, "configuration-conflict");
    assert.equal(operation.error?.retryable, true);
    assert.deepEqual(backend.calls, []);
  });
});

test("backend install failure marks failed with download-failed and retryable", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const backend = fakeBackend({
      installTool: async () => {
        throw new Error("network down");
      },
    });
    const service = createService(store, backend, memoryDeclarations({}));
    const operation = await service.prepare({ ...SCOPE, requestId: "req-6", purpose: "worktree" });
    assert.equal(operation.status, "failed");
    assert.equal(operation.error?.code, "download-failed");
    assert.equal(operation.error?.stage, "installingTools");
    assert.ok(operation.error?.message.includes("network down"));
  });
});

test("resolveContext requires ready and returns frozen context; token internal", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const service = createService(store, fakeBackend(), memoryDeclarations({}));
    const operation = await service.prepare({ ...SCOPE, requestId: "req-7", purpose: "worktree" });
    assert.equal(operation.status, "succeeded");
    const context = await service.resolveContext({
      ...SCOPE,
      environmentId: operation.environmentId,
      consumer: "session",
    });
    assert.equal(context.environmentId, operation.environmentId);
    assert.equal(context.revision, 1);
    assert.equal(context.toolPaths.node, "/fake/tools/node-24.14.0");
    assert.match(context.resourceLeaseToken, /^lease-/);
  });
});

test("resolveContext on non-ready environment throws", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const service = createService(
      store,
      fakeBackend(),
      memoryDeclarations({
        issues: [
          { code: "configuration-conflict", source: "mise.toml", message: "冲突" },
        ],
      }),
    );
    await service.prepare({ ...SCOPE, requestId: "req-8", purpose: "worktree" });
    await assert.rejects(
      service.resolveContext({
        ...SCOPE,
        environmentId: environmentIdFor(SCOPE, undefined, "worktree"),
        consumer: "session",
      }),
      /is failed, not consumable/,
    );
  });
});

test("release settles released; stale expectedRevision is blocked as stale-reference", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const service = createService(store, fakeBackend(), memoryDeclarations({}));
    const operation = await service.prepare({ ...SCOPE, requestId: "req-9", purpose: "worktree" });
    const stale = await service.release({
      ...SCOPE,
      requestId: "req-9",
      environmentId: operation.environmentId,
      expectedRevision: 0,
    });
    assert.equal(stale.status, "releaseBlocked");
    assert.match(stale.reason ?? "", /stale-reference/);
    const released = await service.release({
      ...SCOPE,
      requestId: "req-9",
      environmentId: operation.environmentId,
      expectedRevision: 1,
    });
    assert.equal(released.status, "released");
  });
});

test("reconcile returns original operation without replaying installs", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const backend = fakeBackend();
    const service = createService(store, backend, memoryDeclarations({}));
    await service.prepare({ ...SCOPE, requestId: "req-10", purpose: "worktree" });
    backend.calls.length = 0;
    const reconciled = await service.reconcile({ ...SCOPE, requestId: "req-10" });
    assert.equal(reconciled.operation?.status, "succeeded");
    assert.deepEqual(backend.calls, []);
  });
});

test("capabilities reports managed with backend availability; missing managed gives reason", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const service = createService(store, fakeBackend(), memoryDeclarations({}));
    const caps = await service.getCapabilities(SCOPE);
    assert.equal(caps.managedEnvironments, true);
    assert.equal(caps.backend?.kind, "mise");
    const unavailable = createRuntimeEnvironmentServiceForTests({
      store,
      backend: fakeBackend(),
      declarations: memoryDeclarations({}),
      managed: false,
      missingReason: "host-not-supported",
    });
    const caps2 = await unavailable.getCapabilities(SCOPE);
    assert.equal(caps2.managedEnvironments, false);
    assert.equal(caps2.missingReason, "host-not-supported");
  });
});

test("list filters by identity key (workspaceIdentity precedence)", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const service = createService(store, fakeBackend(), memoryDeclarations({}));
    await service.prepare({
      workspacePath: "C:/proj",
      workspaceIdentity: "ident-A",
      requestId: "req-11",
      purpose: "worktree",
    });
    await service.prepare({
      workspacePath: "C:/other",
      workspaceIdentity: "ident-B",
      requestId: "req-12",
      purpose: "worktree",
    });
    const listA = await service.list({
      workspacePath: "C:/whatever",
      workspaceIdentity: "ident-A",
    });
    assert.equal(listA.length, 1);
    assert.equal(listA[0]?.environmentId, environmentIdFor(
      { workspacePath: "C:/proj", workspaceIdentity: "ident-A" },
      undefined,
      "worktree",
    ));
  });
});

test("store persists records with schema validation and rejects corrupt records", async () => {
  await withTempDir(async (dir) => {
    const store = createRuntimeEnvironmentStore(dir);
    const service = createService(store, fakeBackend(), memoryDeclarations({}));
    const operation = await service.prepare({ ...SCOPE, requestId: "req-13", purpose: "worktree" });
    const envId = operation.environmentId;
    const raw = await readFile(join(dir, "records", `${envId}.json`), "utf8");
    assert.match(raw, /"environmentId"/);
    // 损坏记录必须明确失败，不静默变 null。
    await writeFile(join(dir, "records", `${envId}.json`), "{broken", "utf8");
    await assert.rejects(
      store.readEnvironment(envId),
      /corrupt or has an unknown schema version/,
    );
  });
});

test("real declaration reader parses files from disk", async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "mise.toml"),
      '[tools]\nnode = "24.14.0"\n',
      "utf8",
    );
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9'\n", "utf8");
    const { createDeclarationReader } = await import("../adapters/declarationsReader.js");
    const reader = createDeclarationReader();
    const parsed = await reader.read(dir);
    assert.equal(parsed.issues.length, 0);
    const node = parsed.tools.find((tool) => tool.key === "node");
    assert.equal(node?.constraint, "24.14.0");
    assert.equal(parsed.lockfiles[0]?.name, "pnpm-lock.yaml");
  });
});

test("operationId and environmentId are stable per identity and request", async () => {
  const id1 = operationIdFor(SCOPE, "req-x");
  // identity 相同、路径拼写不同 → 同一幂等键（identity key 优先于路径）。
  const id1b = operationIdFor({ ...SCOPE, workspacePath: "C:/proj-different-spelling" }, "req-x");
  const id2 = operationIdFor({ ...SCOPE, workspaceIdentity: "ident-2" }, "req-x");
  assert.equal(id1, id1b);
  assert.notEqual(id1, id2);
  assert.match(id1, /^[a-f0-9]{32}$/);
  assert.match(environmentIdFor(SCOPE, undefined, "worktree"), /^[a-f0-9]{32}$/);
});
