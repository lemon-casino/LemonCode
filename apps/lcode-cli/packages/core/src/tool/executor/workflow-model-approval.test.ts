import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HookEventName,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSubmitRequest,
  type DynamicWorkflowRunAmendRequest,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@lcode/contracts";
import type { HookRunner } from "../../hooks/index.js";
import { PermissionService } from "../../permission/service.js";
import { createWorkflowToolEntry } from "../handlers/create-workflow.js";
import { amendWorkflowToolEntry } from "../handlers/amend-workflow.js";
import { ToolRegistryImpl } from "../registry.js";
import { createToolExecutor } from "./impl.js";
import type { ToolExecutorOptions } from "./types.js";

const script = [
  'const executor = agent("executor");',
  'const reviewer = agent("reviewer");',
  'phase("Execute");',
  'const result = await executor.ask("fixture execute");',
  'phase("Review");',
  "return await reviewer.ask(result);",
].join("\n");
const overrides = [
  {
    siteId: "actor#1",
    selection: {
      providerId: "provider-executor",
      modelId: "executor-model",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  },
  {
    siteId: "actor#2",
    selection: {
      providerId: "provider-reviewer",
      modelId: "reviewer-model",
      options: { reasoningLevel: "low", speed: "standard" },
    },
  },
];
const prefix = "lcode-workflow-model-approval-";

async function fixture(
  t: test.TestContext,
  options: {
    toolName?: "CreateWorkflow" | "AmendWorkflow";
    deliveryKind?: "desktop-continuous" | "web-remote-replayable";
    answer?: (
      request: PermissionBrokerRequest,
    ) => PermissionBrokerResult | Promise<PermissionBrokerResult>;
    hookRunner?: HookRunner;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    assert.ok(directory.startsWith(join(tmpdir(), prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  const requests: Array<DynamicWorkflowRunSubmitRequest | DynamicWorkflowRunAmendRequest> = [];
  const approvals: PermissionBrokerRequest[] = [];
  const events: SessionEvent[] = [];
  const snapshot = {
    taskId: "fixture-run",
    status: "completed",
    runStatus: "completed",
    parentSessionId: "other-session",
  };
  const port = {
    submit: async (request: DynamicWorkflowRunSubmitRequest) => {
      requests.push(request);
      return { ok: true, runId: "fixture-run" };
    },
    amend: async (request: DynamicWorkflowRunAmendRequest) => {
      requests.push(request);
      return { ok: true, runId: "fixture-revision", supersededRunId: "fixture-run" };
    },
    getTask: async () => snapshot,
    waitForTask: async () => snapshot,
    getScript: async () => 'return "predecessor";',
  } as unknown as DynamicWorkflowRunPort;
  const toolName = options.toolName ?? "CreateWorkflow";
  const registry = new ToolRegistryImpl();
  registry.register(
    toolName === "CreateWorkflow" ? createWorkflowToolEntry : amendWorkflowToolEntry,
  );
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(),
    permissionBroker: {
      requestPermission: async (request) => {
        approvals.push(request);
        return (
          options.answer?.(request) ?? {
            decision: "modify",
            modifiedInput: { ...(request.input as object), actor_model_overrides: overrides },
          }
        );
      },
    },
    emitEvent: async (event) => {
      events.push(event);
    },
    sessionId: "fixture-session",
    getWorkingDirectory: () => directory,
    getWorkspaceRoot: () => directory,
    getMode: () => "build",
    clientMode: options.deliveryKind ?? "desktop-continuous",
    deliveryKind: options.deliveryKind ?? "desktop-continuous",
    hookRunner: options.hookRunner,
    dynamicWorkflowRunPort: port,
  } as ToolExecutorOptions);
  const execute = (
    input: unknown = toolName === "CreateWorkflow" ? { script } : { run_id: "fixture-run", script },
  ) => executor.execute({ id: "fixture-call", name: toolName, input } as never);
  return { execute, requests, approvals, events, directory };
}

for (const toolName of ["CreateWorkflow", "AmendWorkflow"] as const) {
  for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
    test(`${toolName} preserves approved actor models through ${deliveryKind} execution`, async (t) => {
      const h = await fixture(t, { toolName, deliveryKind });
      const result = await h.execute();
      assert.equal(result.success, true, JSON.stringify(result.error));
      assert.equal(h.approvals.length, 1);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.requests[0]?.actorModelOverrides, overrides);
      assert.equal(h.requests[0]?.scriptText, script);
    });
  }
}

test("path-sourced workflow keeps resolved facts and approval models", async (t) => {
  const h = await fixture(t);
  const path = join(h.directory, "workflow.ts");
  await writeFile(path, script);
  const result = await h.execute({ path });
  assert.equal(result.success, true, JSON.stringify(result.error));
  assert.equal(h.requests[0]?.scriptPath, path);
  assert.deepEqual(h.requests[0]?.actorModelOverrides, overrides);
});

test("approval without an override leaves workflow model inheritance intact", async (t) => {
  const h = await fixture(t, { answer: () => ({ decision: "allow" }) });
  assert.equal((await h.execute()).success, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.actorModelOverrides, undefined);
});

test("malformed approval never submits a workflow", async (t) => {
  const h = await fixture(t, {
    answer: (request) => ({
      decision: "modify",
      modifiedInput: {
        ...(request.input as object),
        actor_model_overrides: [{ ...overrides[0], ordinal: 0 }],
      },
    }),
  });
  assert.equal((await h.execute()).success, false);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.requests.length, 0);
});

test("model-authored approval fields fail before prompting or submitting", async (t) => {
  const h = await fixture(t);
  assert.equal((await h.execute({ script, actor_model_overrides: overrides })).success, false);
  assert.equal(h.approvals.length, 0);
  assert.equal(h.requests.length, 0);
});

for (const hookEventName of [HookEventName.PreToolUse, HookEventName.PermissionRequest]) {
  test(`${hookEventName} retains resolved workflow facts under runtime validation`, async (t) => {
    const h = await fixture(t, {
      toolName: "AmendWorkflow",
      answer: () =>
        hookEventName === HookEventName.PermissionRequest
          ? new Promise<PermissionBrokerResult>(() => {})
          : { decision: "allow" },
      hookRunner: {
        run: async (event) => {
          if (event.hookEventName !== hookEventName) return { additionalContexts: [] };
          const updatedInput = { ...(event.toolInput as object), actor_model_overrides: overrides };
          return hookEventName === HookEventName.PreToolUse
            ? { additionalContexts: [], updatedInput }
            : {
                additionalContexts: [],
                permissionRequestResult: { behavior: "allow", updatedInput },
              };
        },
      } as HookRunner,
    });
    assert.equal((await h.execute()).success, true);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0]?.actorModelOverrides, overrides);
  });
}
