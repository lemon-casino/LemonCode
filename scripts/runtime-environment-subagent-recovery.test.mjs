// 真实 Git worktree、离线本地依赖安装和后台进程；工具下载与模型调用不在本回归范围。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createRuntimeEnvironmentStore } from "../packages/services/src/runtime-environment/adapters/store.ts";
import { createDeclarationReader } from "../packages/services/src/runtime-environment/adapters/declarationsReader.ts";
import { createRuntimeConsumerAuthority } from "../packages/services/src/runtime-environment/app/consumerLifecycle.ts";
import { createRuntimeEnvironmentServiceForTests } from "../packages/services/src/runtime-environment/node.ts";
import { createWorktreeEnvironmentRelease } from "../packages/services/src/runtime-environment/app/worktreeRelease.ts";
import { createRuntimeEnvironmentClient } from "../packages/services/src/lcode-agent/runtimeEnvironmentRequests.ts";
import { createNodeExecutionAdapter } from "../apps/lcode-cli/packages/adapters/src/exec/index.ts";
import { createProjectScopedExecutionPort } from "../apps/lcode-cli/packages/bootstrap/src/app/project-environment-execution.ts";
import { createProjectEnvironmentOverlayResolver } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/project-environment-overlay.ts";
import { resolveRunCommand } from "./spawn-command.mjs";

const execute = promisify(execFile);
const pnpm = resolveRunCommand("pnpm");

test(
  "dependency installation and background execution stay in their worktree; shutdown releases the exact owner before upgrade",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-worktree-recovery-"));
    const origin = join(root, "origin");
    const checkout = join(root, "task");
    const sibling = join(root, "sibling");
    await mkdir(origin);
    const originalPackage = JSON.stringify({
      name: "worktree-fixture",
      version: "1.0.0",
      private: true,
    });
    await writeFile(join(origin, "package.json"), originalPackage);
    const git = (args) => execute("git", args, { cwd: origin, windowsHide: true });
    await git(["init", "-b", "main"]);
    await git(["add", "package.json"]);
    await git([
      "-c",
      "user.name=Runtime Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ]);
    await git(["worktree", "add", "-b", "task", checkout]);
    await git(["worktree", "add", "-b", "sibling", sibling]);

    const raw = createNodeExecutionAdapter({ outputRootDir: join(root, "exec-a") });
    const other = createNodeExecutionAdapter({ outputRootDir: join(root, "exec-b") });
    const preparationRunner = createNodeExecutionAdapter({
      outputRootDir: join(root, "preparation"),
    });
    const store = createRuntimeEnvironmentStore(join(root, "data"));
    const service = createRuntimeEnvironmentServiceForTests({
      store,
      declarations: createDeclarationReader(),
      appDefaultTools: [
        { key: "node", version: process.versions.node },
        { key: "pnpm", version: "10.34.6" },
      ],
      backend: {
        probeBackend: async () => ({ available: true }),
        ensureBackend: async () => "fixture-tools",
        installTool: async () => ({ toolPath: process.execPath }),
      },
      dependencies: {
        install: async ({ cwd, signal }) => {
          const result = await preparationRunner.run(
            {
              command: {
                mode: "argv",
                file: pnpm.command,
                args: [
                  ...pnpm.args,
                  "install",
                  "--offline",
                  "--frozen-lockfile",
                  "--ignore-scripts",
                ],
              },
              cwd,
            },
            { signal },
          );
          return {
            exitCode: result.exitCode ?? -1,
            stdout: result.stdout.text,
            stderr: result.stderr.text,
          };
        },
      },
    });
    const prepared = await service.prepare({
      workspacePath: checkout,
      bindingId: "binding-a",
      requestId: "prepare-a",
      purpose: "worktree",
    });
    assert.equal(prepared.status, "succeeded");
    const record = await store.readEnvironment(prepared.environmentId);
    const reference = {
      environmentId: record.environmentId,
      revision: record.currentRevision,
      manifestDigest: record.manifestDigest,
    };
    const binding = {
      id: "binding-a",
      taskId: "session-a",
      status: "ready",
      workspacePath: checkout,
      checkoutPath: checkout,
      originalWorkspacePath: origin,
      environmentRef: reference,
    };
    const consumers = createRuntimeConsumerAuthority(store, () => new Date().toISOString());
    const client = createRuntimeEnvironmentClient({
      service,
      consumers,
      worktrees: { getBinding: async () => binding },
      workspace: { workspacePath: origin },
      clientId: "fixture-origin-agent",
    });
    const resolver = createProjectEnvironmentOverlayResolver(
      { requestClient: (method, params) => client.handle(method, params) },
      {
        workspacePath: checkout,
        workspaceKey: checkout,
        executionBindingId: binding.id,
        environmentRef: reference,
      },
      binding.taskId,
    );
    const scoped = createProjectScopedExecutionPort(raw, resolver);
    t.after(async () => {
      await Promise.all([scoped.close(), other.close(), preparationRunner.close()]);
      await client.disposeAfterProcessExit();
      await rm(root, { recursive: true, force: true });
    });
    const command = (script) =>
      scoped.run(
        { command: { mode: "argv", file: process.execPath, args: ["-e", script] }, cwd: checkout },
        { signal: t.signal },
      );
    assert.equal((await command("console.log(process.cwd())")).stdout.text.trim(), checkout);

    await mkdir(join(checkout, "local-kit"));
    await writeFile(
      join(checkout, "local-kit", "package.json"),
      JSON.stringify({ name: "fixture-local", version: "1.0.0", main: "index.cjs" }),
    );
    await writeFile(
      join(checkout, "local-kit", "index.cjs"),
      "module.exports = 'installed-in-worktree';",
    );
    await writeFile(
      join(checkout, "package.json"),
      JSON.stringify({
        ...JSON.parse(originalPackage),
        dependencies: { "fixture-local": "file:./local-kit" },
      }),
    );
    const installed = await scoped.run(
      {
        command: {
          mode: "argv",
          file: pnpm.command,
          args: [...pnpm.args, "install", "--offline", "--ignore-scripts"],
        },
        cwd: checkout,
      },
      { signal: t.signal },
    );
    assert.equal(installed.exitCode, 0, installed.stderr.text);
    assert.ok((await readFile(join(checkout, "pnpm-lock.yaml"), "utf8")).includes("fixture-local"));
    // 后续子代理复用父执行端口；真实命令加载刚装的依赖，并仍落在同一 worktree cwd。
    assert.equal(
      (await command("console.log(require('fixture-local'))")).stdout.text.trim(),
      "installed-in-worktree",
    );
    assert.equal((await store.readEnvironment(reference.environmentId)).status, "needsUpdate");

    const worker = Buffer.from(
      "process.stdout.write('worktree-ready\\n');setInterval(()=>{},1000)",
    ).toString("base64");
    const background = (port, cwd, sessionId) =>
      port.runBashWithBackgroundLifecycle(
        {
          command: {
            mode: "shell",
            shellProfile: "posix-bash",
            command: `"${process.execPath.replaceAll("\\", "/")}" -e "eval(Buffer.from('${worker}','base64').toString())"`,
          },
          cwd,
          trace: { traceId: sessionId, sessionId },
        },
        { mode: "explicit" },
        { signal: t.signal },
      );
    const a = await background(scoped, checkout, "session-a");
    const b = await background(other, sibling, "session-b");
    assert.equal(a.kind, "backgrounded");
    assert.equal(b.kind, "backgrounded");
    while (true) {
      const output = await scoped.readBackgroundBashOutput(a.task.taskId, "session-a");
      if (output.kind === "output" && output.output.includes("worktree-ready")) break;
      t.signal.throwIfAborted();
      await setImmediate(undefined, { signal: t.signal });
    }
    assert.equal(await readFile(join(origin, "package.json"), "utf8"), originalPackage);
    assert.equal(await readFile(join(sibling, "package.json"), "utf8"), originalPackage);
    assert.equal((await git(["status", "--porcelain"])).stdout, "");
    await assert.rejects(readFile(join(origin, "pnpm-lock.yaml")), { code: "ENOENT" });
    await assert.rejects(readFile(join(sibling, "node_modules", "fixture-local", "index.cjs")), {
      code: "ENOENT",
    });

    // 更新 fence 后关闭实际 app owner，真实后台进程退出才释放环境引用；兄弟进程仍存活。
    const release = createWorktreeEnvironmentRelease({
      store,
      stamp: () => new Date().toISOString(),
      stopAll: async () => ({ status: "stopped" }),
      clearRebuildable: async () => {},
      discardResources: async () => {},
    });
    const update = {
      workspacePath: checkout,
      environmentId: reference.environmentId,
      bindingId: binding.id,
      requestId: "upgrade-a",
      expectedRevision: reference.revision,
      expectedManifestDigest: reference.manifestDigest,
      intent: "upgrade",
    };
    await release({ ...update, phase: "fence" });
    await assert.rejects(command("console.log('fenced')"), /not ready/);
    await scoped.close();
    assert.equal((await scoped.waitForBackgroundTask(a.task.taskId)).status, "cancelled");
    assert.equal((await other.getBackgroundTask(b.task.taskId)).status, "running");
    assert.doesNotThrow(() => process.kill(b.task.pid, 0));
    assert.equal(
      (await store.listConsumers(reference.environmentId)).filter(
        (ref) => ref.kind === "process" && ref.state === "active",
      ).length,
      0,
    );
    assert.equal((await release({ ...update, phase: "stop" })).status, "completed");
    const upgraded = await service.prepare({
      workspacePath: checkout,
      environmentId: reference.environmentId,
      bindingId: binding.id,
      requestId: update.requestId,
      expectedRevision: reference.revision,
      expectedManifestDigest: reference.manifestDigest,
      purpose: "worktree",
      operation: "upgrade",
    });
    assert.equal(upgraded.status, "succeeded", upgraded.error?.message);
    assert.equal(
      (await store.readEnvironment(reference.environmentId)).currentRevision,
      reference.revision + 1,
    );
  },
);
