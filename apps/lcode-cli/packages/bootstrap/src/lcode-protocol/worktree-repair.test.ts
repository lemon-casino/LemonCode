import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId, SessionEventType, type SessionEntryInfo } from "@lcode/contracts";
import type { TurnResult } from "@lcode/core";
import { lcodeProtocolMethods } from "@lcode/shared";
import { createWorktreeRepairRunner } from "./worktree-repair.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

function fixture() {
  const parentId = createSessionId("parent");
  const parent = {
    workspace: {
      workspacePath: "/task",
      workspaceKey: "/task",
      originWorkspacePath: "/origin",
      executionBindingId: "binding",
    },
  } as LCodeProtocolSessionRecord;
  const entries = new Map<string, SessionEntryInfo>();
  const requests: string[] = [];
  let finish!: (turn: TurnResult) => void;
  let complete!: () => void;
  let entered!: () => void;
  const completing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hostCompletion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let prompts = 0;
  let prompt = "";
  const context = {
    sessions: new Map([[parentId, parent]]),
    deps: {
      sessionStore: {
        sessionEntries: async () => [...entries.values()],
        saveSessionEntry: async (entry: SessionEntryInfo) => {
          entries.set(entry.id, entry);
        },
        messages: async () => [{ parts: [{ type: "text", text: "parent intent" }] }],
        getSession: async (id: string) => (context.sessions.has(id) ? { id } : null),
      },
    },
    requestClient: async (method: string, params: { workspacePath: string }) => {
      assert.equal(params.workspacePath, "/origin");
      requests.push(method);
      if (method === lcodeProtocolMethods.worktreePrepareRepair)
        return {
          operationId: "operation",
          parentSessionId: parentId,
          bindingId: "binding",
          workspacePath: "/integration",
          sourceHead: "source",
          targetHead: "target",
          conflictPaths: ["file.ts"],
        };
      entered();
      await hostCompletion;
      return { operationId: "operation", status: "awaiting-review", candidateHead: "candidate" };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const create = async (
    _parent: LCodeProtocolSessionRecord,
    repair: { workspacePath: string },
    childId: string,
  ) => {
    assert.equal(repair.workspacePath, "/integration");
    const child = {
      app: {
        sendInput: async (input: string) => {
          prompts++;
          prompt = input;
          return {
            kind: "started_turn",
            completion: new Promise<TurnResult>((resolve) => {
              finish = resolve;
            }),
          };
        },
      },
    } as unknown as LCodeProtocolSessionRecord;
    context.sessions.set(childId, child);
    return child;
  };
  const runner = createWorktreeRepairRunner(context, create);
  const outcome = (resultType: string) =>
    ({
      events: [{ type: SessionEventType.TurnComplete, payload: { resultType } }],
    }) as unknown as TurnResult;
  return {
    runner,
    context,
    create,
    entries,
    requests,
    parentId,
    parent,
    completing,
    complete,
    finish: (result: string) => finish(outcome(result)),
    prompts: () => prompts,
    prompt: () => prompt,
  };
}

test("repair ACK is idempotent; completion waits for Host candidate and durable settlement", async () => {
  const f = fixture();
  const input = { operationId: "operation", requestId: "repair-request" };
  const started = await f.runner(f.parentId, input);
  assert.equal((await f.runner(f.parentId, input)).sessionId, started.sessionId);
  assert.equal(f.prompts(), 1);
  assert.match(f.prompt(), /Frozen source HEAD: source/);
  assert.match(f.prompt(), /parent intent/);
  assert.equal(f.parent.workspace.workspacePath, "/task");
  let settled = false;
  const waiting = f
    .runner(f.parentId, {
      operationId: "operation",
      requestId: "wait",
      waitForRequestId: input.requestId,
    })
    .then((result) => {
      settled = true;
      return result;
    });
  f.finish("success");
  await f.completing;
  assert.equal(settled, false);
  f.complete();
  assert.equal((await waiting).sessionId, started.sessionId);
  assert.equal((f.entries.values().next().value!.data as { status: string }).status, "completed");
  assert.equal(
    f.requests.filter((method) => method === lcodeProtocolMethods.worktreeCompleteRepair).length,
    1,
  );
  const restarted = createWorktreeRepairRunner(f.context, f.create);
  assert.equal(
    (
      await restarted(f.parentId, {
        operationId: "operation",
        requestId: "wait-again",
        waitForRequestId: input.requestId,
      })
    ).sessionId,
    started.sessionId,
  );
});

test("cancelled and non-success turns retain partial files without completing a candidate", async () => {
  for (const outcome of ["cancelled", "error_max_budget", "error_during_execution"]) {
    const f = fixture();
    await f.runner(f.parentId, { operationId: "operation", requestId: "repair-request" });
    f.finish(outcome);
    await assert.rejects(
      f.runner(f.parentId, {
        operationId: "operation",
        requestId: "wait",
        waitForRequestId: "repair-request",
      }),
      /did not complete successfully/,
    );
    assert.equal(f.requests.includes(lcodeProtocolMethods.worktreeCompleteRepair), false);
  }
});

test("repair request cannot be reused for another operation; interrupted settlement fails closed", async () => {
  const f = fixture();
  await f.runner(f.parentId, { operationId: "operation", requestId: "repair-request" });
  await assert.rejects(
    f.runner(f.parentId, { operationId: "different", requestId: "repair-request" }),
    /scope mismatch/,
  );
  const restarted = createWorktreeRepairRunner(f.context, f.create);
  await assert.rejects(
    restarted(f.parentId, {
      operationId: "operation",
      requestId: "wait",
      waitForRequestId: "repair-request",
    }),
    /interrupted/,
  );
  f.finish("cancelled");
});
