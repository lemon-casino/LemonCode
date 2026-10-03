import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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
import type { CommandEnvelope } from "../packages/shared/src/lcode-protocol-v4/index.js";

test(
  "createSession first input and existing sendText traverse the real checkout bridge and Core",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const binding = await f.service.prepare({
      workspacePath: f.repo,
      taskId: "tree-owner",
      requestId: "tree-create",
    });
    const client = createWorktreeClientLeases(f.service, "fixture-cli");
    t.after(() => client.disposeAfterProcessExit());
    for (const mode of ["local", "worktree"] as const) {
      await t.test(mode, async () => {
        const scope = { workspacePath: mode === "local" ? f.repo : binding.workspacePath };
        const { runtime, storedEvents } = createMockRuntime({ cwd: scope.workspacePath });
        const records = new Map<string, V4SessionRecordView>();
        const completions: Promise<unknown>[] = [];
        const requests: string[] = [];
        const service =
          mode === "local"
            ? client.service
            : {
                ...client.service,
                getBinding: async () => binding,
              };
        runtime.checkoutExecutionPort = createProtocolCheckoutExecutionPort(
          {
            requestClient: async (method: string, params: unknown) => {
              requests.push(method);
              return handleWorktreeRequest(
                method,
                JSON.parse(JSON.stringify(params)),
                { workspacePath: f.repo },
                service,
              );
            },
          } as unknown as LCodeProtocolAgentServerContext,
          {
            ...scope,
            workspaceKey: scope.workspacePath,
            ...(mode === "worktree" ? { executionBindingId: binding.id } : {}),
          },
        );
        const record = {
          traceContext: runtime.rootTraceContext,
          workspace: scope,
          persistence: "deferred",
          app: {
            sessionId: runtime.sessionId,
            runtime,
            getModel: () => "test-provider/test-model",
            getMode: () => "build",
            getThoughtLevel: () => "",
            sendInput: async (
              input: { text: string },
              options: Parameters<typeof runtime.admitPrompt>[2],
            ) => {
              const admitted = await runtime.admitPrompt(input.text, undefined, options);
              if (admitted.kind === "started") completions.push(admitted.completion);
              return admitted;
            },
          },
        } as unknown as V4SessionRecordView;
        const executor = new V4CommandExecutor({
          getRecord: (id) => records.get(id),
          createSessionRecord: async () => {
            records.set(runtime.sessionId, record);
            return { sessionId: runtime.sessionId };
          },
        } as V4CommandCoreHost);
        const gateway = new ConversationV4Gateway({
          sessionExists: (id) => records.has(id),
          emitWireFrame: () => {},
          getSessionWorkspaceId: () => f.repo,
          getSessionIndexMeta: () => ({
            createdAt: 1,
            lastActivityAt: 1,
            ...(mode === "worktree" ? { executionBindingId: binding.id } : {}),
          }),
          listWorkspaceSessionIds: () => [...records.keys()],
          isDraftSession: (id) => records.get(id)?.persistence === "deferred",
          executeCommand: (envelope, admission) => executor.execute(envelope, admission),
        });
        const append = runtime.eventStore!.append.bind(runtime.eventStore);
        runtime.eventStore!.append = async (event) => {
          const stored = await append(event);
          gateway.ingest(runtime.sessionId, stored);
          return stored;
        };
        // 侧栏依赖真实 sessions-index；只检查会话消息不能证明新会话已进入列表。
        await gateway.subscribeSessionsIndex({
          topic: `sessions-index/${f.repo}`,
          connectionId: "sidebar-before-send",
          clientMode: "desktop-continuous",
        });
        const send = async (type: CommandEnvelope["type"], text: string) => {
          const commandId = randomUUID();
          const payload = {
            text,
            modelSelection: { providerId: "test-provider", modelId: "test-model" },
            mode: "build",
          };
          const ack = await gateway.handleCommand({
            commandId,
            clientId: "browser-fixture",
            issuedAt: Date.now(),
            type,
            sessionId: type === "createSession" ? null : runtime.sessionId,
            payload:
              type === "createSession" ? { workspaceId: f.repo, firstInput: payload } : payload,
          });
          assert.equal(ack.status, "accepted", JSON.stringify(ack));
          await completions.at(-1);
        };
        await send("createSession", "first input");
        await send("sendText", "existing followup");
        const rows = await gateway.rowsRange({ sessionId: runtime.sessionId, limit: 100 });
        assert.equal(rows.rows.filter((row) => row.kind === "userInput").length, 2);
        assert.equal(rows.rows.filter((row) => row.kind === "assistantText").length, 2);
        assert.match(JSON.stringify(rows.rows), /first input/);
        assert.match(JSON.stringify(rows.rows), /existing followup/);
        assert.match(JSON.stringify(rows.rows), /Mock result/);
        assert.equal(record.persistence, "immediate");
        const index = await gateway.subscribeSessionsIndex({
          topic: `sessions-index/${f.repo}`,
          connectionId: "sidebar-after-send",
          clientMode: "web-remote-replayable",
        });
        const payload = index.initialFrame?.payload;
        assert.equal(payload?.kind, "snapshot");
        if (payload?.kind !== "snapshot") throw new Error("missing sessions-index snapshot");
        const summary = payload.snapshot.sessions.find(
          (entry) => entry.sessionId === runtime.sessionId,
        );
        assert.equal(summary?.workspaceId, f.repo);
        assert.equal(summary?.phase, "completedSuccess");
        assert.equal(summary?.executionBindingId, mode === "worktree" ? binding.id : undefined);
        assert.ok(storedEvents.length > 0);
        assert.equal(requests.filter((method) => method === "checkout/acquireWriter").length, 2);
        assert.equal(requests.filter((method) => method === "checkout/releaseWriter").length, 2);
        gateway.disposeSession(runtime.sessionId);
      });
    }
  },
);

test(
  "real bridge keeps shared checkout busy and independent worktrees writable",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const binding = await f.service.prepare({
      workspacePath: f.repo,
      taskId: "tree-owner",
      requestId: "tree-create",
    });
    const acquire = (sessionId: string, workspacePath = f.repo) =>
      handleWorktreeRequest(
        "checkout/acquireWriter",
        {
          workspacePath,
          sessionId,
          requestId: `${sessionId}:turn`,
        },
        { workspacePath: f.repo },
        f.service,
      );
    const release = (sessionId: string, permit: unknown) =>
      handleWorktreeRequest(
        "checkout/releaseWriter",
        {
          sessionId,
          ...(permit as { permitId: string }),
        },
        { workspacePath: f.repo },
        f.service,
      );
    const first = await acquire("first");
    t.after(async () => {
      await release("first", first);
    });
    assert.deepEqual(await acquire("second"), { busy: true });
    const tree = await acquire("tree-owner", binding.workspacePath);
    await release("tree-owner", tree);
    await release("first", first);
    await release("second", await acquire("second"));
  },
);
