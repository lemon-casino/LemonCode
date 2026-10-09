import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createSessionId } from "../apps/lcode-cli/packages/contracts/src/index.js";
import { summarizeWorktreeTaskName } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/worktree-task-name.js";
import { prepareProtocolExecution } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/worktree-execution.js";
import {
  createWorktreeService,
  type WorktreeGitPort,
} from "../packages/services/src/worktree/node.js";
import { lcodeProtocolMethods } from "../packages/shared/src/index.js";
import type { LCodeProtocolAgentServerContext } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/server-types.js";

test("compound task summaries become real Git worktrees and preserve names across retries and collisions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-task-name-"));
  const checkedRoot = resolve(root);
  t.after(async () => {
    // 测试清理只删除已核对的独立临时目录，不能触碰用户工作区。
    assert.equal(dirname(checkedRoot), resolve(tmpdir()));
    await rm(checkedRoot, { recursive: true, force: true });
  });
  const git: WorktreeGitPort = {
    run: (input) =>
      new Promise((done, reject) => {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        );
        const child = spawn("git", input.args, {
          cwd: input.cwd,
          env: {
            ...env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: join(root, "empty-config"),
            ...input.env,
          },
          windowsHide: true,
          stdio: "pipe",
        });
        let stdout = "",
          stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (exitCode) => done({ stdout, stderr, exitCode }));
        child.stdin.end(input.stdin);
      }),
  };
  const command = async (cwd: string, ...args: string[]) => {
    const result = await git.run({ cwd, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  await command(root, "init", "--initial-branch=main", "repo");
  const repo = join(root, "repo");
  await command(repo, "config", "user.name", "Naming Fixture");
  await command(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "file.txt"), "baseline\n");
  await command(repo, "add", "file.txt");
  await command(repo, "commit", "-m", "baseline");
  const service = createWorktreeService({ dataDir: join(root, "managed"), git });
  let generations = 0;
  let duringGeneration: (() => Promise<void>) | undefined;
  const workspace = { workspacePath: repo, workspaceKey: repo };
  const context = {
    sessions: new Map(),
    deps: {
      createSessionEventStore: () => ({}),
      createLCodeApp: async () => ({
        getModel: () => "fixture/model",
        generateWorkspaceText: async () => {
          generations++;
          await duringGeneration?.();
          return { text: '{"title":"清理帮助与问题上报入口"}' };
        },
        close: async () => {},
      }),
    },
    requestClient: async (method: string, input: any) => {
      if (method === lcodeProtocolMethods.worktreeGetBinding)
        return { binding: await service.getBinding(input) };
      assert.equal(method, lcodeProtocolMethods.worktreePrepareExecution);
      return service.prepare(input);
    },
  } as unknown as LCodeProtocolAgentServerContext;
  for (const [index, requestId] of ["first", "first", "second"].entries()) {
    const taskId = createSessionId(requestId);
    const taskName = await summarizeWorktreeTaskName(context, {
      workspace,
      taskId,
      text: "删除指定内容以更换：点击帮助，删除问题上报；删除其他无用入口。\n统一清理相关界面。",
    });
    const prepared = await prepareProtocolExecution(context, {
      workspace,
      taskId,
      requestId,
      execution: { mode: "worktree", taskName, setupCommands: [] },
    });
    const binding = await service.getBinding({ workspacePath: repo, taskId });
    const expected = `lcode/task-清理帮助与问题上报入口${index === 2 ? "-2" : ""}`;
    assert.equal(binding?.branch, expected);
    assert.equal(
      await command(prepared.workspace.workspacePath, "branch", "--show-current"),
      expected,
    );
    assert.equal(await command(repo, "check-ref-format", "--branch", expected), expected);
    assert.equal(prepared.workspace.executionBindingId, binding?.id);
    assert.equal(generations, index === 2 ? 2 : 1);
  }
  const raceTaskId = createSessionId("race");
  duringGeneration = async () => {
    await service.prepare({
      workspacePath: repo,
      taskId: raceTaskId,
      requestId: "race",
      taskName: "提前冻结名称",
      setupCommands: [],
    });
  };
  const lateTaskName = await summarizeWorktreeTaskName(context, {
    workspace,
    taskId: raceTaskId,
    text: "清理帮助入口和问题上报入口，统一去除重复控制按钮。",
  });
  await prepareProtocolExecution(context, {
    workspace,
    taskId: raceTaskId,
    requestId: "race",
    execution: { mode: "worktree", taskName: lateTaskName, setupCommands: [] },
  });
  assert.equal(
    (await service.getBinding({ workspacePath: repo, taskId: raceTaskId }))?.branch,
    "lcode/task-提前冻结名称",
  );
});
