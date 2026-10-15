import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowExecutionOwnerError } from "@lcode/adapters/storage";
import type { DynamicWorkflowRunPort } from "@lcode/contracts";
import { createProtocolWorkflowRunOwnerRouter } from "./workflow-run-owner-router.js";
import { WorkflowRunOwnerUnavailableError } from "../app/workflow-run-owner-router.js";
import { withSessionResumeFlight } from "./session-resume-flight.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

function fixture(live = true) {
  const workspace = {
    workspacePath: "/fixture",
    workspaceIdentity: "fixture-identity",
    workspaceKey: "fixture-identity",
    remoteSessionId: "attachment-original",
  };
  const port = {} as DynamicWorkflowRunPort;
  const source = { app: { sessionId: "source" }, workspace } as LCodeProtocolSessionRecord;
  const target = {
    app: { sessionId: "target", getDynamicWorkflowRunPort: () => port },
    workspace,
  } as unknown as LCodeProtocolSessionRecord;
  const sessions = new Map([["source", source], ...(live ? [["target", target] as const] : [])]);
  let gates = 0;
  const context = {
    sessions,
    deps: {
      sessionStore: {
        getSession: async () => ({
          path: "/fixture",
          directory: "/fixture",
          workspaceID: "fixture-identity",
        }),
      },
    },
    sessionResidentPool: {
      acquireOperation: async () => {
        gates++;
        return () => {
          gates--;
        };
      },
    },
  } as unknown as LCodeProtocolAgentServerContext;
  let activations = 0;
  const activate = async () => {
    activations++;
    sessions.set("target", target);
    return target;
  };
  const router = createProtocolWorkflowRunOwnerRouter(context, "source", workspace, activate);
  const request = { parentSessionId: "target", runId: "run", operation: "resume" as const };
  return {
    context,
    sessions,
    source,
    target,
    port,
    workspace,
    router,
    request,
    activate,
    gates: () => gates,
    activations: () => activations,
  };
}

test("live original owner is reused and resume admission holds the operation gate", async () => {
  const f = fixture();
  const value = await f.router(f.request, async (port) => {
    assert.equal(port, f.port);
    assert.equal(f.gates(), 1);
    return "accepted";
  });
  assert.equal(value, "accepted");
  assert.equal(f.activations(), 0);
  assert.equal(f.gates(), 0);
});

test("cold routing uses the existing session resume flight for concurrent callers", async () => {
  const f = fixture(false);
  const router = createProtocolWorkflowRunOwnerRouter(
    f.context,
    "source",
    f.workspace,
    (sessionId) =>
      withSessionResumeFlight(f.context, sessionId, async () => ({
        record: await f.activate(),
      })).then((value) => value.record),
  );
  const results = await Promise.all([
    router(f.request, async () => "first"),
    router(f.request, async () => "second"),
  ]);
  assert.deepEqual(results, ["first", "second"]);
  assert.equal(f.activations(), 1);
  assert.equal(f.gates(), 0);
});

for (const field of ["workspaceIdentity", "remoteSessionId"] as const)
  test(`routing rejects another ${field} before activation or execution`, async () => {
    const f = fixture();
    f.target.workspace = { ...f.workspace, [field]: "different" };
    await assert.rejects(
      f.router(f.request, async () => assert.fail("must not execute")),
      WorkflowRunOwnerUnavailableError,
    );
    assert.equal(f.activations(), 0);
    assert.equal(f.gates(), 0);
  });

test("source replacement while a cold lookup waits cannot activate the target", async () => {
  const f = fixture(false);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.context.deps.sessionStore!.getSession = async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return null;
  };
  const rejected = assert.rejects(
    f.router(f.request, async () => assert.fail("must not execute")),
    WorkflowRunOwnerUnavailableError,
  );
  await started;
  f.sessions.set("source", { ...f.source });
  release();
  await rejected;
  assert.equal(f.activations(), 0);
});

test("a live owner outside this runtime causes explicit refusal", async () => {
  const f = fixture(false);
  const router = createProtocolWorkflowRunOwnerRouter(
    f.context,
    "source",
    f.workspace,
    async () => {
      throw new WorkflowExecutionOwnerError("owner_active");
    },
  );
  await assert.rejects(
    router(f.request, async () => assert.fail("must not execute")),
    WorkflowRunOwnerUnavailableError,
  );
  assert.equal(f.gates(), 0);
});

test("long observation releases the global operation gate before settlement", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = f.router({ ...f.request, operation: "waitForTask" }, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return "settled";
  });
  await started;
  assert.equal(f.gates(), 0);
  release();
  assert.equal(await pending, "settled");
});
