import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  createCheckoutCoordinator,
  createWorktreeService,
  type WorktreeGitPort,
} from "../worktree/node.js";
import type { IWorktreeHostService } from "../worktree/contract.js";
import type { ILCodeAgentService } from "../lcode-agent/lcodeAgent.js";
import { createRuntimeEnvironmentHost, createWorktreeRuntimePorts } from "./node.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";

const mise = process.env.LCODE_RUNTIME_TEST_MISE;
const cachedStore = process.env.LCODE_RUNTIME_TEST_TOOL_STORE;
const lock =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

test(
  "real Git worktree and candidate use production frozen environments through archive, restore and delete",
  {
    timeout: 180_000,
    skip: mise && cachedStore ? false : "requires verified fixed mise and tool-store fixtures",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lcode-worktree-runtime-"));
    const repo = join(root, "repo");
    const dataDir = join(root, "worktrees");
    const environmentDir = join(root, "runtime-environments");
    await mkdir(repo);
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
    };
    const git: WorktreeGitPort = {
      run: (params) =>
        new Promise((resolveRun) => {
          const child = execFile(
            "git",
            params.args,
            {
              cwd: params.cwd,
              env: { ...gitEnv, ...params.env },
              windowsHide: true,
              maxBuffer: params.maxOutputBytes ?? 16 * 1024 * 1024,
              timeout: params.timeoutMs ?? 60_000,
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
    let host: ReturnType<typeof createRuntimeEnvironmentHost> | undefined;
    try {
      await command(repo, "init", "--initial-branch=main");
      await command(repo, "config", "user.name", "Runtime Fixture");
      await command(repo, "config", "user.email", "runtime@example.invalid");
      await writeFile(join(repo, ".gitignore"), "node_modules/\n");
      await writeFile(join(repo, ".node-version"), "24.14.0\n");
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "runtime-worktree-fixture",
          version: "1.0.0",
          packageManager: "pnpm@10.33.2",
        }),
      );
      await writeFile(join(repo, "pnpm-lock.yaml"), lock);
      await writeFile(join(repo, "file.txt"), "base\n");
      await command(repo, "add", ".");
      await command(repo, "commit", "-m", "baseline");
      const target = join(environmentDir, "tool-store/mise/v2026.10.2/windows-x64");
      await mkdir(dirname(target), { recursive: true });
      await cp(cachedStore!, target, { recursive: true });
      const coordinator = createCheckoutCoordinator({ dataDir, git });
      host = createRuntimeEnvironmentHost(environmentDir, {
        backendPath: mise!,
        resolveEnv: async () => ({
          ...process.env,
          CI: "true",
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        }),
        acquireWriter: async (params) => {
          const lease = await coordinator.acquire(params);
          return () => coordinator.release(lease);
        },
      });
      const runtime = host;
      const store = createRuntimeEnvironmentStore(environmentDir);
      let rebindings = 0;
      const agents = {
        disposeWorkspace: async () => {},
        rebindWorktreeSessions: async () => {
          rebindings++;
          return { sessionIds: ["task"] };
        },
        cleanupWorktreeSessions: async () => ({ sessionIds: [] }),
      } as unknown as ILCodeAgentService;
      let worktrees!: IWorktreeHostService;
      const ports = createWorktreeRuntimePorts({
        host: runtime,
        coordinator,
        worktrees: () => worktrees,
        agents: () => agents,
        stopWorktreeExecution: async (binding) => agents.disposeWorkspace(binding),
      });
      worktrees = createWorktreeService({
        dataDir,
        git,
        coordinator,
        ...ports,
        collectDiscardSessions: async () => ["task"],
        discardSessions: async (binding, sessionIds) => {
          await runtime.consumers.releaseSessionsAfterDeletion({
            workspacePath: binding.checkoutPath,
            environmentId: binding.environmentRef!.environmentId,
            bindingId: binding.id,
            sessionIds,
          });
        },
      });
      const binding = await worktrees.prepare({
        workspacePath: repo,
        taskId: "task",
        requestId: "create",
        environmentPolicy: "managed",
        setupCommands: [],
      });
      assert.equal(binding.status, "ready");
      assert.ok(binding.environmentRef?.manifestDigest);
      assert.equal(
        (await store.readDependencyReceipt(binding.environmentRef.environmentId))?.exitCode,
        0,
      );
      await runtime.consumers.acquire({
        workspacePath: binding.checkoutPath,
        ...binding.environmentRef,
        kind: "session",
        id: "task",
        ownerId: `binding:${binding.id}`,
      });
      await writeFile(join(binding.checkoutPath, "file.txt"), "source\n");
      await command(binding.checkoutPath, "add", ".");
      await command(binding.checkoutPath, "commit", "-m", "candidate change");
      const operation = await worktrees.integrate({
        bindingId: binding.id,
        requestId: "integrate",
        targetBranch: "main",
        expectedSourceHead: await command(binding.checkoutPath, "rev-parse", "HEAD"),
        validationCommands: ["node --version"],
      });
      const validated = await worktrees.continueIntegration({
        operationId: operation.id,
        approvedCandidateHead: operation.candidateHead,
      });
      assert.equal(validated.status, "ready", validated.error);
      assert.ok(validated.environmentRef);
      assert.notEqual(validated.environmentRef.environmentId, binding.environmentRef.environmentId);
      assert.match(validated.validationResults[0]?.output ?? "", /v24\.14\.0/);
      const published = await worktrees.publishIntegration({
        operationId: operation.id,
        approvedCandidateHead: validated.candidateHead!,
      });
      assert.equal(published.status, "published", published.error);
      assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "source\n");
      const archived = await worktrees.archive({
        bindingId: binding.id,
        requestId: "archive",
        acknowledgeIgnoredFiles: true,
      });
      assert.equal(archived.status, "archived");
      const restored = await worktrees.restore({ bindingId: binding.id, requestId: "restore" });
      assert.equal(restored.status, "ready", restored.error);
      assert.ok(restored.environmentRef);
      assert.notEqual(restored.environmentRef.environmentId, binding.environmentRef.environmentId);
      assert.equal(rebindings, 1);
      assert.equal(
        (await store.readEnvironment(binding.environmentRef.environmentId))?.status,
        "released",
      );
      assert.equal(
        (await store.listConsumers(restored.environmentRef.environmentId)).filter(
          (item) => item.state === "active",
        ).length,
        1,
      );
      const deleted = await worktrees.archive({
        bindingId: restored.id,
        requestId: "discard",
        discard: { branch: restored.branch, checkoutPath: restored.checkoutPath },
      });
      assert.equal(deleted.status, "deleted", deleted.error);
      assert.equal(
        (await store.readEnvironment(restored.environmentRef.environmentId))?.status,
        "released",
      );
    } finally {
      await host?.disposeAndWait();
      await rm(root, { recursive: true, force: true });
    }
  },
);
