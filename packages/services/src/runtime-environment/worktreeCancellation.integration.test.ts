import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  createCheckoutCoordinator,
  createWorktreeService,
  type WorktreeGitPort,
} from "../worktree/node.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeEnvironmentService } from "./app/runtimeEnvironmentService.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";
import { createWorktreeRuntimePorts } from "./worktreeWiring.js";

test("failed managed creation cancels idempotently and deletes only its worktree, preserving the original local directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-cancellation-"));
  let runtime: ReturnType<typeof createRuntimeEnvironmentService> | undefined;
  t.after(async () => {
    await runtime?.disposeAndWait();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const git: WorktreeGitPort = {
    run: (params) =>
      new Promise((resolveRun) => {
        // 隔离用户继承的 GIT_DIR/GIT_WORK_TREE 等变量，保证测试只操作自己的临时仓库。
        const inherited = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        );
        const child = execFile(
          "git",
          params.args,
          {
            cwd: params.cwd,
            env: {
              ...inherited,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
              ...params.env,
            },
            windowsHide: true,
            maxBuffer: params.maxOutputBytes ?? 16 * 1024 * 1024,
          },
          (error, stdout, stderr) =>
            resolveRun({ stdout, stderr, exitCode: error ? Number(error.code) || 1 : 0 }),
        );
        child.stdin?.end(params.stdin);
      }),
  };
  const command = async (cwd: string, ...args: string[]) => {
    const result = await git.run({ cwd, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  await command(root, "init", "--initial-branch=main", "repo");
  const repo = join(root, "repo");
  const project = join(repo, "packages", "app");
  await mkdir(project, { recursive: true });
  await command(repo, "config", "user.name", "Cancellation Fixture");
  await command(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(project, "file.txt"), "committed project\n");
  await writeFile(join(repo, "local.txt"), "committed local\n");
  await writeFile(join(repo, ".gitignore"), "cache/\n");
  await command(repo, "add", ".");
  await command(repo, "commit", "-m", "baseline");
  await writeFile(join(repo, "local.txt"), "staged local\n");
  await command(repo, "add", "local.txt");
  await writeFile(join(repo, "local.txt"), "unstaged local\n");
  await writeFile(join(repo, "untracked.txt"), "untracked local\n");
  await mkdir(join(repo, "cache"));
  await writeFile(join(repo, "cache", "data.txt"), "ignored local\n");
  const original = async () => ({
    head: await command(repo, "rev-parse", "HEAD"),
    index: await command(repo, "ls-files", "--stage"),
    status: await command(repo, "status", "--porcelain", "--untracked-files=all"),
    contents: await Promise.all(
      ["local.txt", "untracked.txt", "cache/data.txt", "packages/app/file.txt"].map((file) =>
        readFile(join(repo, file), "utf8"),
      ),
    ),
  });
  const before = await original();
  const store = createRuntimeEnvironmentStore(join(root, "environments"));
  let installations = 0;
  runtime = createRuntimeEnvironmentService({
    store,
    declarations: {
      read: async () => ({ tools: [], lockfiles: [], ambiguousLocks: false, issues: [] }),
    },
    backend: {
      ensureBackend: async () => "/fixture/mise",
      probeBackend: async () => ({ available: true }),
      installTool: async () => {
        installations++;
        throw new Error("fixture tool install failed");
      },
    },
  });
  const options = { dataDir: join(root, "worktrees"), git };
  const coordinator = createCheckoutCoordinator(options);
  const stamp = () => new Date().toISOString();
  const disposed: string[] = [];
  const ports = createWorktreeRuntimePorts({
    host: {
      service: runtime,
      prepareUnderWriter: runtime.prepareUnderWriter,
      consumers: createRuntimeConsumerAuthority(store, stamp),
      releaseForWorktree: createWorktreeEnvironmentRelease({
        store,
        stamp,
        stopAll: async () => ({ status: "stopped" }),
        clearRebuildable: async () => {},
        discardResources: async () => {},
      }),
    },
    coordinator,
    worktrees: () => worktree,
    stopWorktreeExecution: async (binding) => {
      disposed.push(binding.workspacePath);
    },
    agents: () =>
      ({
        disposeWorkspace: async (scope: { workspacePath: string }) => {
          disposed.push(scope.workspacePath);
        },
      }) as never,
  });
  const worktree = createWorktreeService({
    ...options,
    coordinator,
    ...ports,
    collectDiscardSessions: async () => [],
    discardSessions: async () => {},
  });
  const request = {
    workspacePath: project,
    taskId: "owner",
    requestId: "original",
    environmentPolicy: "managed" as const,
    setupCommands: [],
  };
  await assert.rejects(worktree.prepare(request), /fixture tool install failed/);
  const failed = await worktree.getBinding({ workspacePath: project, taskId: "owner" });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.environmentRef?.revision, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const cancelled = await worktree.prepare({ ...request, cancel: true });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.environmentRef, failed?.environmentRef);
    assert.equal(cancelled.preparation?.cancelRequested, true);
    await assert.rejects(worktree.prepare(request), /cancelled/);
  }
  assert.equal(installations, 1);
  assert.equal(
    (await store.readEnvironment(failed!.environmentRef!.environmentId))?.status,
    "failed",
  );
  const deleted = await worktree.archive({
    bindingId: failed!.id,
    requestId: "discard",
    discard: { branch: failed!.branch, checkoutPath: failed!.checkoutPath },
  });
  assert.equal(deleted.status, "deleted");
  assert.equal(
    (await store.readEnvironment(failed!.environmentRef!.environmentId))?.status,
    "released",
  );
  await assert.rejects(access(failed!.checkoutPath), { code: "ENOENT" });
  assert.deepEqual(disposed, [failed!.workspacePath]);
  assert.deepEqual(await original(), before);
});
