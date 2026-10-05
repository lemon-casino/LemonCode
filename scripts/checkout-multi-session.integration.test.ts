import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSessionId } from "../apps/lcode-cli/packages/contracts/src/index.js";
import { fixture } from "../packages/services/src/worktree/testFixture.js";
import { handleWorktreeRequest } from "../packages/services/src/lcode-agent/worktreeRequests.js";
import { createWorktreeClientLeases } from "../packages/services/src/lcode-agent/worktreeClientLeases.js";
import { createProtocolCheckoutExecutionPort } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/checkout-execution-port.js";
import { createMockRuntime } from "../apps/lcode-cli/packages/core/src/runtime/methods/lint-runtime-fixture.js";
import { V4CommandExecutor } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/commands/executor.js";
import { ConversationV4Gateway } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/v4-gateway.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/commands/types.js";
import type { LCodeProtocolAgentServerContext } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/server-types.js";
import type { ModelStreamEvent } from "../apps/lcode-cli/packages/contracts/src/index.js";

test(
  "local sessions, two worktrees and same-tree forks execute concurrently through Core and V4",
  {
    timeout: 30_000,
  },
  async (t) => {
    const f = await fixture(t);
    const ids = Array.from({ length: 5 }, () => createSessionId());
    const trees = await Promise.all(
      ids.slice(2, 4).map((taskId) =>
        f.service.prepare({
          workspacePath: f.repo,
          taskId,
          requestId: taskId,
        }),
      ),
    );
    await f.service.prepare({
      workspacePath: f.repo,
      taskId: ids[4]!,
      requestId: "same-tree-fork",
      parentBinding: {
        bindingId: trees[0]!.id,
        bindingOwnerTaskId: ids[2]!,
        parentTaskId: ids[2]!,
      },
    });
    const scopes = [
      f.repo,
      f.repo,
      trees[0]!.workspacePath,
      trees[1]!.workspacePath,
      trees[0]!.workspacePath,
    ];
    const bindings = [undefined, undefined, trees[0], trees[1], trees[0]];
    const client = createWorktreeClientLeases(f.service, "multi-session-cli");
    const records = new Map<string, V4SessionRecordView>();
    const executor = new V4CommandExecutor({
      getRecord: (id) => records.get(id),
    } as V4CommandCoreHost);
    const gateway = new ConversationV4Gateway({
      sessionExists: (id) => records.has(id),
      emitWireFrame: () => {},
      getSessionWorkspaceId: () => f.repo,
      getSessionIndexMeta: (id) => ({
        createdAt: 1,
        lastActivityAt: 1,
        executionBindingId: bindings[ids.indexOf(id as (typeof ids)[number])]?.id,
      }),
      listWorkspaceSessionIds: () => [...records.keys()],
      executeCommand: (envelope, admission) => executor.execute(envelope, admission),
    });
    const completions: Promise<unknown>[] = [];
    const releases: (() => void)[] = [];
    const starts: Promise<void>[] = [];
    t.after(async () => {
      releases.forEach((release) => release());
      await Promise.allSettled(completions);
      for (const id of ids) gateway.disposeSession(id);
      await client.disposeAfterProcessExit();
    });
    for (const [index, id] of ids.entries()) {
      let started!: () => void;
      starts.push(
        new Promise((resolve) => {
          started = resolve;
        }),
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.push(release);
      const { runtime } = createMockRuntime(
        { cwd: scopes[index] },
        async function* (): AsyncIterable<ModelStreamEvent> {
          started();
          yield { type: "text_start", id: "answer" };
          yield { type: "text_delta", id: "answer", text: `reply-${index}` };
          await gate;
          yield { type: "text_end", id: "answer" };
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        },
        id,
      );
      runtime.checkoutExecutionPort = createProtocolCheckoutExecutionPort(
        {
          requestClient: (method: string, params: unknown) =>
            handleWorktreeRequest(
              method,
              JSON.parse(JSON.stringify(params)),
              { workspacePath: f.repo },
              client.service,
            ),
        } as unknown as LCodeProtocolAgentServerContext,
        {
          workspacePath: scopes[index]!,
          workspaceKey: scopes[index]!,
          ...(bindings[index] ? { executionBindingId: bindings[index]!.id } : {}),
        },
      );
      records.set(id, {
        traceContext: runtime.rootTraceContext,
        workspace: { workspacePath: scopes[index]! },
        persistence: "immediate",
        app: {
          sessionId: id,
          runtime,
          getModel: () => "test-provider/test-model",
          getMode: () => "build",
          getThoughtLevel: () => "",
          sendInput: async (
            input: { text: string },
            options: Parameters<typeof runtime.admitPrompt>[2],
          ) => {
            const admission = await runtime.admitPrompt(input.text, undefined, options);
            if (admission.kind === "started") completions.push(admission.completion);
            return admission;
          },
        },
      } as unknown as V4SessionRecordView);
      const append = runtime.eventStore!.append.bind(runtime.eventStore);
      runtime.eventStore!.append = async (event) => {
        const stored = await append(event);
        gateway.ingest(id, stored);
        return stored;
      };
    }
    for (const [index, id] of ids.entries()) {
      for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
        await gateway.subscribe({
          topic: `conversation/${id}`,
          connectionId: `${clientMode}-${id}`,
          clientMode,
        });
      }
      const ack = await gateway.handleCommand({
        commandId: randomUUID(),
        clientId: "multi-pane",
        issuedAt: Date.now(),
        type: "sendText",
        sessionId: id,
        payload: {
          text: `input-${index}`,
          mode: "build",
          modelSelection: { providerId: "test-provider", modelId: "test-model" },
        },
      });
      assert.equal(ack.status, "accepted", JSON.stringify(ack));
    }
    // 每个模型都开始前不释放任何会话，避免顺序完成掩盖目录串行回归。
    await Promise.all(starts);
    for (const [index, id] of ids.entries()) {
      const rows = await gateway.rowsRange({ sessionId: id, limit: 100 });
      assert.equal(rows.rows.filter((row) => row.kind === "userInput").length, 1);
      assert.match(JSON.stringify(rows.rows), new RegExp(`input-${index}`));
      assert.equal(records.get(id)!.app.runtime.config.cwd, scopes[index]);
    }
    for (const path of new Set(scopes)) {
      await assert.rejects(
        f.service.acquireCheckout({
          workspacePath: path!,
          ownerId: "archive-or-publish",
          waitMs: 80,
        }),
        {
          code: "LCODE_CHECKOUT_BUSY",
        },
      );
    }
    releases.forEach((release) => release());
    await Promise.all(completions);
    const index = await gateway.subscribeSessionsIndex({
      topic: `sessions-index/${f.repo}`,
      connectionId: "mobile-after-reconnect",
      clientMode: "web-remote-replayable",
    });
    assert.equal(index.initialFrame?.payload.kind, "snapshot");
    if (index.initialFrame?.payload.kind !== "snapshot") throw new Error("missing snapshot");
    for (const [position, id] of ids.entries()) {
      const rows = await gateway.rowsRange({ sessionId: id, limit: 100 });
      assert.match(JSON.stringify(rows.rows), new RegExp(`reply-${position}`));
      const summary = index.initialFrame.payload.snapshot.sessions.find(
        (session) => session.sessionId === id,
      );
      assert.equal(summary?.workspaceId, f.repo);
      assert.equal(summary?.executionBindingId, bindings[position]?.id);
      const permit = await f.service.acquireCheckout({
        workspacePath: scopes[position]!,
        ownerId: `publish-${position}`,
      });
      await f.service.releaseCheckout({ token: permit.token, ownerId: permit.ownerId });
    }
  },
);
