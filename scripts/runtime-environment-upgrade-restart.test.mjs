// 真实受管 Agent、Git worktree、SQLite 正文与 cold restore；验证重启恢复不删除用户内容。
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "../packages/services/src/runtime-environment/legacyDiscard.fixture.ts";
import { LCodeAgentProcessManager } from "../packages/services/src/lcode-agent/lcodeAgentProcessManager.ts";
import { createRuntimeEnvironmentClient } from "../packages/services/src/lcode-agent/runtimeEnvironmentRequests.ts";
import { createNativeProcessOwnerObserver } from "../packages/services/src/runtime-environment/adapters/processOwnerObservation.ts";
import { createRuntimeEnvironmentStore } from "../packages/services/src/runtime-environment/adapters/store.ts";
import { createRuntimeEnvironmentService } from "../packages/services/src/runtime-environment/app/runtimeEnvironmentService.ts";
import { createRuntimeConsumerAuthority } from "../packages/services/src/runtime-environment/app/consumerLifecycle.ts";
import { createWorktreeEnvironmentRelease } from "../packages/services/src/runtime-environment/app/worktreeRelease.ts";
import { createWorktreeRuntimePorts } from "../packages/services/src/runtime-environment/worktreeWiring.ts";
import {
  createCheckoutCoordinator,
  createWorktreeService,
} from "../packages/services/src/worktree/node.ts";
import { lcodeProtocolMethods } from "../packages/shared/src/lcode-protocol/index.ts";
import { createSqliteSessionStore } from "../apps/lcode-cli/packages/adapters/src/storage/session-store.ts";
import { restoreProtocolExecution } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/worktree-execution.ts";

test(
  "persisted session resumes after an explicit upgrade recovers the exited pre-restart Agent owner",
  { timeout: 30000 },
  async (t) => {
    let removeFixture;
    const f = await fixture({
      after: (cleanup) => {
        removeFixture = cleanup;
      },
    });
    const manager = new LCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        cwd: f.repo,
      }),
    });
    const store = createRuntimeEnvironmentStore(join(f.root, "environments"));
    const sessions = createSqliteSessionStore({ dbPath: join(f.root, "sessions.sqlite") });
    t.after(async () => {
      await manager.disposeAllAndWait();
      sessions.close();
      await removeFixture();
    });
    const observe = createNativeProcessOwnerObserver((owner) =>
      manager.hasOwnedProcessOwner(owner),
    );
    const stamp = () => new Date().toISOString();
    let changed = false;
    const runtime = createRuntimeEnvironmentService({
      store,
      declarations: {
        read: async () => ({
          tools: [],
          lockfiles: [],
          ambiguousLocks: false,
          issues: [],
          configurationDigests: { ".npmrc": (changed ? "b" : "a").repeat(64) },
        }),
      },
      backend: {
        ensureBackend: async () => "unused",
        probeBackend: async () => ({ available: true }),
        installTool: async ({ key }) => ({ toolPath: join(f.root, "tools", key) }),
      },
    });
    const consumers = createRuntimeConsumerAuthority(store, stamp, observe);
    const coordinator = createCheckoutCoordinator(f.options);
    let worktrees;
    const ports = createWorktreeRuntimePorts({
      host: {
        service: runtime,
        consumers,
        prepareUnderWriter: runtime.prepareUnderWriter,
        releaseForWorktree: createWorktreeEnvironmentRelease({
          store,
          stamp,
          observeProcessOwner: observe,
          stopAll: async () => ({ status: "stopped" }),
          clearRebuildable: async () => {},
          discardResources: async () => {},
        }),
      },
      coordinator,
      worktrees: () => worktrees,
      agents: () => ({
        rebindWorktreeSessions: async ({ rebind }) => {
          const result = await sessions.worktreeRebind(rebind);
          return sessions.worktreeRebind({ ...rebind, expectedSessionIds: result.sessionIds });
        },
      }),
      stopWorktreeExecution: async () => {},
    });
    const options = { ...f.options, coordinator, ...ports };
    worktrees = createWorktreeService(options);
    const binding = await worktrees.prepare({
      workspacePath: f.repo,
      taskId: "root",
      requestId: "prepare",
      environmentPolicy: "managed",
      setupCommands: [],
    });
    const scope = { workspacePath: binding.checkoutPath };
    const workspace = {
      executionBindingId: binding.id,
      originWorkspacePath: f.repo,
      workspacePath: binding.workspacePath,
      workspaceKey: binding.workspacePath,
      environmentRef: binding.environmentRef,
    };
    for (const id of ["root", "hidden"]) {
      await sessions.createSession({
        id,
        projectID: "fixture",
        slug: id,
        title: `Keep ${id}`,
        directory: binding.workspacePath,
        path: binding.workspacePath,
        version: "fixture",
        taskType: id === "root" ? "interactive" : "subagent_child",
        initialEntries: [
          {
            id: `binding-${id}`,
            sessionID: id,
            type: "runtime/worktree_binding",
            time: { created: 1, updated: 1 },
            data: workspace,
            touchSession: false,
          },
        ],
      });
      await sessions.saveMessage({
        id: `msg-${id}`,
        sessionID: id,
        role: "user",
        time: { created: 2 },
        agent: "fixture",
      });
      await sessions.savePart({
        id: `part-${id}`,
        messageID: `msg-${id}`,
        sessionID: id,
        type: "text",
        text: `Keep message ${id}`,
      });
      await consumers.acquire({
        ...scope,
        ...binding.environmentRef,
        kind: "session",
        id,
        ownerId: `binding:${binding.id}`,
      });
    }
    const before = sessions.debugCounts("root");
    const bodyBefore = await sessions.messages({ sessionID: "root" });
    await writeFile(join(binding.checkoutPath, "keep.txt"), "keep worktree changes\n");
    const client = await manager.getClient({ workspacePath: f.repo });
    const oldOwner = manager.getOwnedProcessOwner(client);
    assert.ok(oldOwner?.pid);
    const processReference = await consumers.acquire(
      {
        ...scope,
        ...binding.environmentRef,
        kind: "process",
        id: JSON.stringify(["root", "33333333-3333-4333-8333-333333333333"]),
        ownerId: `runtime-agent-${oldOwner.runtimeInstanceId}`,
      },
      oldOwner,
    );
    changed = true;
    const request = {
      bindingId: binding.id,
      requestId: "original-update",
      expectedEnvironmentRef: binding.environmentRef,
    };
    await assert.rejects(
      worktrees.upgradeRuntimeEnvironment(request),
      /execution owner has not confirmed exit/,
    );
    // 真实 owner 关闭，但故意没有环境 bridge 的退出收据，复现旧 Host ticket 丢失。
    await manager.disposeWorkspace({ workspacePath: f.repo });
    assert.equal(observe(oldOwner), "absent");
    assert.equal(
      (await store.listConsumerOwnerReceipts(binding.environmentRef.environmentId))[0]
        .exitConfirmedAt,
      undefined,
    );
    const writerBlock = await coordinator.acquire({
      workspacePath: binding.checkoutPath,
      ownerId: "busy-reader",
      mode: "shared",
    });
    try {
      await assert.rejects(worktrees.upgradeRuntimeEnvironment(request), /busy/i);
      assert.deepEqual(
        await store.listConsumerRetirements(binding.environmentRef.environmentId),
        [],
      );
    } finally {
      await coordinator.release(writerBlock);
    }
    worktrees = createWorktreeService(options);
    const ready = await worktrees.upgradeRuntimeEnvironment(request);
    assert.equal(ready.status, "ready");
    assert.equal(ready.environmentRef.revision, binding.environmentRef.revision + 1);
    assert.equal(
      await readFile(join(ready.checkoutPath, "keep.txt"), "utf8"),
      "keep worktree changes\n",
    );
    assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "baseline\n");
    assert.deepEqual(sessions.debugCounts("root"), before);
    assert.equal((await sessions.getSession("hidden")).title, "Keep hidden");
    assert.deepEqual(await sessions.messages({ sessionID: "root" }), bodyBefore);
    const audit = (await store.listConsumerRetirements(binding.environmentRef.environmentId))[0];
    assert.equal(audit.reason, "confirmed-environment-upgrade");
    assert.equal(audit.lease, processReference.lease);
    assert.equal(audit.requestId, request.requestId);
    assert.deepEqual(audit.orphanedOwner.processOwner, JSON.parse(JSON.stringify(oldOwner)));
    const reverse = createRuntimeEnvironmentClient({
      service: runtime,
      consumers,
      worktrees,
      workspace: { workspacePath: f.repo },
      clientId: "resumed-fixture",
    });
    const resumed = await restoreProtocolExecution(
      {
        deps: { sessionStore: sessions },
        requestClient: async (method, params, schema) => {
          const value =
            method === lcodeProtocolMethods.worktreeGetBinding
              ? { binding: await worktrees.getBinding(params) }
              : await reverse.handle(method, params);
          return schema.parse(value);
        },
      },
      {
        taskId: "root",
        workspace: { workspacePath: f.repo, workspaceKey: f.repo },
        persistedWorkspace: {
          workspacePath: ready.workspacePath,
          workspaceKey: ready.workspacePath,
        },
      },
    );
    assert.deepEqual(resumed.workspace.environmentRef, ready.environmentRef);
    assert.equal(resumed.workspace.workspacePath, ready.checkoutPath);
  },
);
