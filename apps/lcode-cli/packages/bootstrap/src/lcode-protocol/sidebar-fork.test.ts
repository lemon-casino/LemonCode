import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId, type MessageWithParts } from "@lcode/contracts";
import { createSidebarForkHost } from "./v4-bridge-sidebar-fork.js";
import { prepareForkWorktree } from "./worktree-fork-execution.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";
import { V4CommandExecutor } from "../lcode-protocol-v4/commands/executor.js";
import type { V4CommandCoreHost } from "../lcode-protocol-v4/commands/types.js";
import type { CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";

const options = {
  workspaceMode: "same" as const,
  sourceCommandId: "fork-command",
  revisionAtDecision: 7,
};
const anchor = {
  productTurnId: "turn",
  turnId: "turn",
  orderedMessageIds: ["user", "assistant"],
  boundaryMessageId: "assistant",
  goalBoundary: { kind: "none" },
};

test("sidebar fork fixes the latest stable transcript boundary without running the parent", async () => {
  const pages: unknown[] = [];
  const calls: unknown[] = [];
  const context = {
    sessions: new Map(),
    deps: {
      sessionStore: {
        messages: async () =>
          [
            { info: { id: "user", role: "user", anchor }, parts: [] },
            {
              info: {
                id: "assistant",
                role: "assistant",
                parentID: "user",
                anchor,
                time: { completed: 1 },
              },
              parts: [],
            },
          ] as unknown as MessageWithParts[],
      },
    },
    v4Gateway: {
      rowsRange: async (request: { beforeRowId?: number }) => {
        pages.push(request);
        return request.beforeRowId === undefined
          ? {
              rows: [{ rowId: 20, kind: "assistantText", actions: { canFork: false } }],
              hasMore: true,
            }
          : {
              rows: [{ rowId: 10, kind: "assistantText", actions: { canFork: true } }],
              hasMore: false,
            };
      },
      resolveStableForkCandidate: () => ({
        ok: true,
        candidate: {
          productTurnId: "turn",
          transcriptTurnId: "turn",
          startMessageId: "user",
          boundaryMessageId: "assistant",
        },
      }),
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const host = createSidebarForkHost(context, async (_sessionId, request) => {
    calls.push(request);
    return { forkedSessionId: "child", workspacePath: "/origin" };
  });
  assert.deepEqual(await host.forkSession!("parent", options), {
    sessionId: "child",
    workspacePath: "/origin",
    workspaceIdentity: undefined,
  });
  assert.equal(pages.length, 2);
  assert.equal((calls[0] as { target: typeof anchor }).target.boundaryMessageId, "assistant");
  assert.equal((calls[0] as { commandResultType: string }).commandResultType, "forkSession");
});

test("sidebar native command keeps decision revision, owner and workspace mode", async () => {
  let received: unknown;
  const executor = new V4CommandExecutor({
    getRecord: () => ({ app: { sessionId: "parent" } }),
    forkSession: async (
      _id: string,
      request: Parameters<NonNullable<V4CommandCoreHost["forkSession"]>>[1],
    ) => {
      received = request;
      return { sessionId: "child", workspacePath: "/tree" };
    },
  } as unknown as V4CommandCoreHost);
  const result = await executor.execute({
    type: "forkSession",
    sessionId: "parent",
    commandId: "fork-command",
    baseRevision: 7,
    payload: { workspaceMode: "worktree" },
  } as CommandEnvelope);
  assert.deepEqual(received, { ...options, workspaceMode: "worktree" });
  assert.equal(result?.type, "forkSession");
});

test("new-tree fork retains its new environment, never the source reference", async () => {
  const sourceRef = { environmentId: "a".repeat(32), revision: 1 };
  const newRef = { environmentId: "b".repeat(32), revision: 1 };
  const retained: Record<string, unknown>[] = [];
  const record = {
    workspace: { workspacePath: "/origin", workspaceKey: "/origin", environmentRef: sourceRef },
    app: { sessionId: "parent" }, executionMcpServers: [],
  } as unknown as LCodeProtocolSessionRecord;
  const context = {
    deps: { sessionStore: { getSession: async () => ({ title: "fork" }) } },
    requestClient: async (method: string, params: Record<string, unknown>) => {
      if (method === "worktree/getBinding") return { binding: null };
      if (method === "runtimeEnvironment/retainSession") { retained.push(params); return { retained: true }; }
      return {
        status: "ready", taskId: String(createSessionId("new-tree")), id: "new-binding",
        originalWorkspacePath: "/origin", workspacePath: "/new-tree", checkoutPath: "/new-tree",
        repositoryRoot: "/origin", environmentRef: newRef,
      };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const prepared = await prepareForkWorktree(context, record, "new-tree");
  assert.deepEqual(prepared.workspace.environmentRef, newRef);
  assert.equal(retained.length, 1);
  assert.deepEqual(retained[0]?.environmentRef, newRef);
  assert.equal(retained[0]?.sessionId, prepared.taskId);
});

test("new worktree fork refuses running sources and rejects foreign bindings before child commit", async () => {
  const record = {
    activeAbortController: new AbortController(),
    workspace: { workspacePath: "/origin" },
    app: { sessionId: "parent" },
    executionMcpServers: [],
  } as unknown as LCodeProtocolSessionRecord;
  const context = {
    deps: { sessionStore: { getSession: async () => ({ title: "优化模型设置" }) } },
    requestClient: async () => {
      throw new Error("must not prepare a busy source");
    },
  } as unknown as LCodeProtocolAgentServerContext;
  await assert.rejects(prepareForkWorktree(context, record, "command"), /busy/);
  record.activeAbortController = undefined;
  const calls: unknown[] = [];
  context.requestClient = (async (_method: string, request: unknown) => {
    calls.push(request);
    return calls.length === 1
      ? { binding: null }
      : { status: "ready", taskId: "foreign", originalWorkspacePath: "/foreign" };
  }) as typeof context.requestClient;
  await assert.rejects(prepareForkWorktree(context, record, "command"), /owner/);
  assert.equal(
    (calls[1] as { forkSource: { workspacePath: string } }).forkSource.workspacePath,
    "/origin",
  );
  assert.equal((calls[1] as { taskName: string }).taskName, "优化模型设置");
});
