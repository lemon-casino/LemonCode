import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId } from "@lcode/contracts";
import { lcodeProtocolMethods } from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { summarizeWorktreeTaskName } from "./worktree-task-name.js";

const workspace = {
  workspacePath: "/fixture",
  workspaceIdentity: "fixture-identity",
  workspaceKey: "fixture-identity",
  remoteSessionId: "attachment-fixture",
};
const taskId = createSessionId("naming-command");
const selection = { providerId: "fixture-provider", modelId: "fixture-model" };
const text =
  "删除指定内容以更换：点击帮助，删除问题上报；删除其他无用入口。\n统一清理帮助与问题上报入口。";

function fixture(
  options: {
    result?: string;
    binding?: unknown;
    model?: string;
    error?: Error;
    toolCalls?: unknown[];
  } = {},
) {
  const calls: { method: string; params: any; options?: any }[] = [];
  let closed = 0;
  const app = {
    getModel: () => options.model ?? "fixture-provider/fixture-model",
    generateWorkspaceText: async (params: unknown, requestOptions: unknown) => {
      calls.push({ method: "generate", params, options: requestOptions });
      if (options.error) throw options.error;
      return {
        text: options.result ?? '{"title":"清理帮助与问题上报入口"}',
        toolCalls: options.toolCalls,
      };
    },
    close: async () => {
      closed++;
    },
  };
  const context = {
    sessions: new Map(),
    appRuntimePreferences: {},
    deps: {
      createSessionEventStore: () => ({}),
      createLCodeApp: async (params: unknown) => {
        calls.push({ method: "app", params });
        return app;
      },
    },
    requestClient: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { binding: options.binding ?? null };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const run = (input = text, modelSelection?: typeof selection, fallbackName?: string) =>
    summarizeWorktreeTaskName(context, {
      workspace,
      taskId,
      text: input,
      modelSelection,
      fallbackName,
    });
  return { context, calls, app, run, closed: () => closed };
}

test("long multiline tasks are summarized before Git naming using frozen source and selected model", async () => {
  const f = fixture();
  assert.equal(await f.run(text, selection), "清理帮助与问题上报入口");
  assert.deepEqual(
    f.calls.map((call) => call.method),
    [lcodeProtocolMethods.worktreeGetBinding, "app", "generate"],
  );
  assert.deepEqual(f.calls[0].params, {
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    taskId,
  });
  const request = f.calls[2];
  assert.deepEqual(request.params.selection, selection);
  assert.equal(request.params.querySource, "worktree_task_name");
  assert.deepEqual(request.params.tools, []);
  assert.match(request.params.messages[1].content, /统一清理帮助与问题上报入口/);
  assert.ok(request.options.abortSignal instanceof AbortSignal);
  assert.equal(request.options.traceContext.sessionId, taskId);
  assert.equal(
    f.calls[1].params.runtimeConfig.memory.workspaceIdentity,
    workspace.workspaceIdentity,
  );
  assert.equal(f.calls[1].params.runtimeConfig.remoteSessionId, workspace.remoteSessionId);
  assert.equal(f.closed(), 1);
});

test("short names and empty inputs need no model or workspace resources", async () => {
  const f = fixture();
  assert.equal(await f.run("修复模型切换"), "修复模型切换");
  assert.equal(await f.run(""), "新会话");
  assert.equal(await f.run("  ", selection, "分叉会话"), "分叉会话");
  assert.equal(f.calls.length, 0);
});

test("only successfully prepared names are offered as session title seeds", async () => {
  for (const options of [
    {},
    { result: "直接回答" },
    { toolCalls: [{ name: "Write" }] },
    { binding: { taskId, status: "ready" } },
  ]) {
    const f = fixture(options);
    const prepared: string[] = [];
    await summarizeWorktreeTaskName(f.context, {
      workspace,
      taskId,
      text,
      onPreparedTitle: (title) => prepared.push(title),
    });
    assert.deepEqual(prepared, Object.keys(options).length === 0 ? ["清理帮助与问题上报入口"] : []);
  }
  const f = fixture();
  let short: string | undefined;
  await summarizeWorktreeTaskName(f.context, {
    workspace,
    taskId,
    text: "修复任务标题",
    onPreparedTitle: (title) => {
      short = title;
    },
  });
  assert.equal(short, "修复任务标题");
  assert.equal(f.calls.length, 0);
});

test("existing bindings skip generation regardless of lifecycle status or renamed input", async () => {
  for (const status of ["ready", "failed", "cancelled", "archived", "deleted"]) {
    const f = fixture({ binding: { taskId, status, branch: "lcode/task-旧名称" } });
    assert.equal(await f.run(), undefined);
    assert.deepEqual(
      f.calls.map((call) => call.method),
      [lcodeProtocolMethods.worktreeGetBinding],
    );
  }
});

test("binding lookup failure and wrong owner never fall back to creating a new name", async () => {
  const f = fixture();
  f.context.requestClient = async () => {
    throw new Error("lookup unavailable");
  };
  await assert.rejects(f.run(), /lookup unavailable/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fixture({ binding: { taskId: "foreign-task" } }).run(), /owner/);
});

test("invalid responses and model failure use a short default and always close temporary resources", async () => {
  for (const options of [
    { result: "直接回答任务" },
    { result: '{"title":""}' },
    { result: '{"title":42}' },
    { result: JSON.stringify({ title: "删除".repeat(20) }) },
    { result: '{"title":"标题\\n解释"}' },
    { result: '{"title":"../@{}[]"}' },
    { result: '{"title":"清理入口","explanation":"额外解释"}' },
    { toolCalls: [{ name: "Write" }] },
    { error: new Error("fixture timeout") },
    { model: "" },
  ]) {
    const f = fixture(options);
    assert.equal(await f.run(), "新会话");
    assert.equal(f.closed(), 1);
  }
});

test("naming resources stay separate from existing conversation streams and model state", async () => {
  const f = fixture();
  const otherApp = {
    generateWorkspaceText: async () => {
      throw new Error("must not generate in another conversation");
    },
    close: async () => {
      throw new Error("must not close another conversation");
    },
  };
  f.context.sessions.set("active", { app: otherApp, workspace } as any);
  assert.equal(await f.run(), "清理帮助与问题上报入口");
  assert.deepEqual(
    f.calls.map((call) => call.method),
    [lcodeProtocolMethods.worktreeGetBinding, "app", "generate"],
  );
  assert.equal(f.closed(), 1);
  const other = fixture();
  other.context.sessions.set("other", {
    app: f.app,
    workspace: {
      ...workspace,
      workspaceIdentity: "another-identity",
      workspaceKey: "another-identity",
    },
  } as any);
  await other.run();
  assert.equal(other.closed(), 1);
});

test("the naming deadline reaches the model and failure retains a short fork fallback", async (t) => {
  const f = fixture();
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    assert.equal(duration, 15_000);
    controller.abort();
    return controller.signal;
  });
  f.app.generateWorkspaceText = async (_params: unknown, options: unknown) => {
    (options as { abortSignal: AbortSignal }).abortSignal.throwIfAborted();
    throw new Error("unreachable");
  };
  assert.equal(await f.run(text, selection, "分叉会话"), "分叉会话");
  assert.equal(f.closed(), 1);
});

test("naming source includes meaningful objects beyond the former 256-character cut", async () => {
  const f = fixture();
  await f.run(`${"背景说明。".repeat(60)}\n清理帮助与问题上报入口`);
  assert.match(f.calls[2].params.messages[1].content, /清理帮助与问题上报入口/);
});
