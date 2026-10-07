import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeEnvironmentServiceForTests } from "./node.js";
import type { RuntimeEnvironmentStore, ToolBackendPort } from "./app/ports.js";

for (const failure of ["manifest", "environment", "operation"] as const) {
  test(`reconcile completes a durable ready intent interrupted at ${failure} without rerunning installations`, async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-commit-"));
    const original = createRuntimeEnvironmentStore(root);
    let interrupted = true;
    const store: RuntimeEnvironmentStore = {
      ...original,
      saveManifest: async (...args) => {
        if (interrupted && failure === "manifest")
          throw new Error("crash before manifest publication");
        return original.saveManifest(...args);
      },
      saveEnvironment: async (value) => {
        if (interrupted && failure === "environment" && value.status === "ready")
          throw new Error("crash before environment publication");
        return original.saveEnvironment(value);
      },
      saveOperation: async (value) => {
        if (interrupted && failure === "operation" && value.status === "succeeded")
          throw new Error("crash before receipt publication");
        return original.saveOperation(value);
      },
    };
    let installs = 0;
    const backend: ToolBackendPort = {
      probeBackend: async () => ({ available: true }),
      ensureBackend: async () => "/fixed/mise",
      installTool: async ({ key }) => {
        installs++;
        return { toolPath: `/fixed/${key}` };
      },
    };
    const declarations = {
      read: async () => ({ tools: [], issues: [], lockfiles: [], ambiguousLocks: false }),
    };
    const params = {
      workspacePath: root,
      bindingId: "binding",
      purpose: "worktree" as const,
      requestId: "commit",
    };
    try {
      const service = createRuntimeEnvironmentServiceForTests({ store, backend, declarations });
      await assert.rejects(service.prepare(params), /crash/);
      assert.equal(installs, 2);
      interrupted = false;
      const restarted = createRuntimeEnvironmentServiceForTests({
        store: createRuntimeEnvironmentStore(root),
        backend,
        declarations,
      });
      const reconciled = await restarted.reconcile({
        workspacePath: root,
        requestId: params.requestId,
      });
      assert.equal(reconciled.operation?.status, "succeeded");
      assert.equal(reconciled.environment?.status, "ready");
      assert.equal(reconciled.environment?.currentRevision, 1);
      assert.equal((await restarted.prepare({ ...params, cancel: true })).status, "succeeded");
      assert.equal((await restarted.prepare(params)).status, "succeeded");
      assert.equal(installs, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
