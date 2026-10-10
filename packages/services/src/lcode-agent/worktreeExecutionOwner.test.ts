import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setDataBaseDir } from "../paths.js";
import type { WorktreeBinding } from "../worktree/contract.js";
import type { IWorktreeService } from "../worktree/contract.js";
import { LCodeAgentProcessManager } from "./lcodeAgentProcessManager.js";
import {
  createLCodeAgentService,
  runtimeProcessOwnerRegistry,
  worktreeExecutionOwner,
} from "./lcodeAgentService.js";

test("Host-only owner registry consults all Agent lanes and cannot be called by RPC name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-owner-registry-"));
  setDataBaseDir(root);
  const managers = new Set<LCodeAgentProcessManager>();
  let present = false;
  t.mock.method(
    LCodeAgentProcessManager.prototype,
    "hasOwnedProcessOwner",
    function (this: LCodeAgentProcessManager) {
      managers.add(this);
      return present;
    },
  );
  const service = createLCodeAgentService();
  t.after(async () => {
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });
  const owner = {
    runtimeInstanceId: "old-runtime",
    runtimeGeneration: 1,
    startedAt: 1,
    workspacePath: root,
  };
  assert.equal(service[runtimeProcessOwnerRegistry](owner), false);
  assert.equal(managers.size, 3);
  present = true;
  assert.equal(service[runtimeProcessOwnerRegistry](owner), true);
  assert.equal(Object.keys(service).includes("runtimeProcessOwnerRegistry"), false);
});

test("Host stops all owned lanes in canonical checkout scopes and preserves other identities and links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-execution-owner-"));
  setDataBaseDir(root);
  const checkout = join(root, "checkout");
  const child = join(checkout, "packages", "server");
  const outside = join(root, "checkout-other");
  await mkdir(child, { recursive: true });
  await mkdir(outside);
  const linked = join(checkout, "linked");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const stopped: { manager: LCodeAgentProcessManager; path: string }[] = [];
  const targets = [
    { workspacePath: checkout },
    { workspacePath: child },
    { workspacePath: child, workspaceIdentity: "other-host" },
    { workspacePath: outside },
    { workspacePath: linked },
  ];
  t.mock.method(LCodeAgentProcessManager.prototype, "listOwnedWorkspaceTargets", () => targets);
  t.mock.method(
    LCodeAgentProcessManager.prototype,
    "disposeWorkspace",
    async function (this: LCodeAgentProcessManager, scope: { workspacePath: string }) {
      stopped.push({ manager: this as LCodeAgentProcessManager, path: scope.workspacePath });
    },
  );
  const service = createLCodeAgentService();
  t.after(async () => {
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });
  await service[worktreeExecutionOwner]({ checkoutPath: checkout } as WorktreeBinding);
  assert.equal(new Set(stopped.map((entry) => entry.manager)).size, 3);
  assert.deepEqual(
    stopped.map((entry) => entry.path).sort(),
    [checkout, checkout, checkout, child, child, child].sort(),
  );
  stopped.length = 0;
  await service[worktreeExecutionOwner]({
    checkoutPath: checkout,
    workspaceIdentity: "other-host",
  } as WorktreeBinding);
  assert.deepEqual(
    stopped.map((entry) => entry.path),
    [child, child, child],
  );
  assert.equal(
    Object.keys(service).includes("stopWorktreeExecution"),
    false,
    "owner must not be callable by RPC string",
  );
});

test("workspace disposal retries retired owners and waits for exact post-exit lease settlement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-retired-owner-"));
  let attempts = 0;
  const manager = new LCodeAgentProcessManager({
    commandResolver: ({ workspacePath }) => ({
      command: process.execPath,
      args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],
      cwd: workspacePath,
    }),
    onProcessCleanupCompleted: async () => {
      if (++attempts <= 2) throw new Error("fixture lease persistence failed");
    },
  });
  const scope = { workspacePath: root };
  t.after(async () => {
    await manager.disposeAllAndWait();
    await rm(root, { recursive: true, force: true });
  });
  const client = await manager.getClient(scope);
  const processOwner = manager.getOwnedProcessOwner(client);
  assert.ok(processOwner);
  assert.equal(manager.hasOwnedProcessOwner(processOwner), true);
  assert.equal(manager.hasOwnedProcessOwner({ ...processOwner, runtimeGeneration: 99 }), false);
  assert.equal(processOwner?.workspacePath, scope.workspacePath);
  assert.equal(processOwner?.runtimeGeneration, 1);
  assert.ok(processOwner?.runtimeInstanceId);
  await assert.rejects(manager.disposeWorkspace(scope), /lease persistence failed/);
  assert.equal(manager.getExistingClient(scope), undefined);
  assert.deepEqual(manager.listOwnedWorkspaceTargets(), [scope]);
  assert.deepEqual(manager.getOwnedProcessOwner(client), processOwner);
  assert.equal(manager.hasOwnedProcessOwner(processOwner), true);
  await manager.disposeWorkspace(scope);
  assert.equal(attempts, 3);
  assert.deepEqual(manager.listOwnedWorkspaceTargets(), []);
  assert.equal(manager.getOwnedProcessOwner(client), undefined);
  assert.equal(manager.hasOwnedProcessOwner(processOwner), false);
});

test("disposal cancels and waits for an admitted pending startup before finishing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-pending-owner-"));
  const admitted = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const manager = new LCodeAgentProcessManager({
    commandResolver: () => ({ command: process.execPath, args: ["-e", "process.stdin.resume()"] }),
    waitForSpawnAdmission: async ({ signal }) => {
      admitted.resolve();
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      await released.promise;
    },
  });
  t.after(async () => {
    released.resolve();
    await manager.disposeAllAndWait();
    await rm(root, { recursive: true, force: true });
  });
  const scope = { workspacePath: root };
  const starting = manager.getClient(scope);
  const rejected = assert.rejects(starting, /cancel|invalidat/i);
  await admitted.promise;
  assert.deepEqual(manager.listOwnedWorkspaceTargets(), [scope]);
  let stopped = false;
  const stopping = manager.disposeWorkspace(scope).then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  released.resolve();
  await Promise.all([rejected, stopping]);
  assert.deepEqual(manager.listOwnedWorkspaceTargets(), []);
});

test("background reads cannot respawn a stopped checkout until Worktree owner confirms restored ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-admission-fence-"));
  setDataBaseDir(root);
  const checkout = join(root, "checkout");
  const child = join(checkout, "server");
  await mkdir(child, { recursive: true });
  const binding = {
    id: "binding-a",
    taskId: "task-a",
    checkoutPath: checkout,
    originalWorkspacePath: root,
    status: "deleting",
  } as WorktreeBinding;
  let current = binding;
  const scopes: unknown[] = [];
  const worktrees = {
    getBinding: async (scope: unknown) => {
      scopes.push(scope);
      return current;
    },
  } as IWorktreeService;
  const service = createLCodeAgentService({
    worktreeService: worktrees,
    commandResolver: () => ({
      command: process.execPath,
      args: [
        "-e",
        "require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.id!==undefined)process.stdout.write(JSON.stringify({id:r.id,result:{sessions:[]}})+'\\n')})",
      ],
    }),
  });
  t.after(async () => {
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });
  await service[worktreeExecutionOwner](binding);
  await assert.rejects(service.listSessions({ workspacePath: child }), /admission is fenced/);
  current = { ...binding, status: "ready", id: "other-binding" };
  await assert.rejects(service.listSessions({ workspacePath: child }), /admission is fenced/);
  current = { ...binding, status: "ready" };
  assert.deepEqual(await service.listSessions({ workspacePath: child }), []);
  assert.deepEqual(scopes, [
    { workspacePath: root, workspaceIdentity: undefined, taskId: "task-a" },
    { workspacePath: root, workspaceIdentity: undefined, taskId: "task-a" },
    { workspacePath: root, workspaceIdentity: undefined, taskId: "task-a" },
  ]);
});
