import assert from "node:assert/strict";
import test from "node:test";
import type {
  CollaborationMode,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  TraceContext,
} from "@lcode/contracts";
import { PermissionService } from "../../permission/service.js";
import { bashToolEntry } from "../handlers/bash.js";
import { createBashProviderDescription } from "../handlers/bash-prompt.js";
import { resolveRuntimePermissionCapability } from "./permission-capability.js";
import { resolveToolApproval } from "./approval-gate.js";
import { applyPreToolPermissionDecision } from "./hook-flow.js";
import { resolveToolPermission } from "./permission-flow.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import type { ToolExecutorDeps } from "./types.js";

const input = { command: "pnpm dev", run_in_background: true, keep_alive_after_task: true };
const trace = {
  traceId: "preview-trace",
  sessionId: "preview-session",
  turnId: "preview-turn",
} as TraceContext;
const call = { id: "preview-call", name: "Bash", input } as never;
const context = { workingDirectory: process.cwd(), workspaceRoot: process.cwd() };

for (const mode of ["yolo", "build", "edit", "plan"] as CollaborationMode[]) {
  test(`retained preview requires a user decision even in ${mode} with broad grants`, () => {
    const service = new PermissionService();
    service.grantSessionPermission([
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] },
    ]);
    const capability = resolveRuntimePermissionCapability(bashToolEntry, input, context);
    const decision = service.checkPermission(
      { toolName: "Bash", input, mode, riskLevel: "high" },
      capability,
      { version: 1, allow: [{ toolName: "Bash" }] },
    );
    assert.equal(decision.decision, "ask");
    assert.equal(decision.alwaysAsk, true);
    assert.equal(capability.permission?.approvalSource, "user");
    assert.equal(
      applyPreToolPermissionDecision(
        decision,
        { additionalContexts: [], permissionBehavior: "allow" },
        mode,
      ).decision,
      "ask",
    );
  });
}

test("retention normalization cannot bypass the gate through readonly commands or boolean strings", () => {
  for (const flag of [true, "true", "1", 1]) {
    const retained = { ...input, command: "pwd", keep_alive_after_task: flag };
    const capability = resolveRuntimePermissionCapability(bashToolEntry, retained, context);
    assert.equal(
      new PermissionService().checkPermission(
        { toolName: "Bash", input: retained, mode: "yolo", riskLevel: "low" },
        capability,
      ).decision,
      "ask",
    );
  }
  for (const flag of [undefined, false, "false"]) {
    const temporary = { ...input, keep_alive_after_task: flag };
    const capability = resolveRuntimePermissionCapability(bashToolEntry, temporary, context);
    assert.equal(
      new PermissionService().checkPermission(
        { toolName: "Bash", input: temporary, mode: "yolo", riskLevel: "high" },
        capability,
      ).decision,
      "allow",
    );
  }
});

test("retention still respects explicit deny and only offers one-time approval", () => {
  const capability = resolveRuntimePermissionCapability(bashToolEntry, input, context);
  assert.equal(
    new PermissionService().checkPermission(
      { toolName: "Bash", input, mode: "yolo", riskLevel: "high" },
      capability,
      { version: 1, deny: [{ toolName: "Bash" }] },
    ).decision,
    "deny",
  );
  const deps = {
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
  } as ToolExecutorDeps;
  assert.equal(
    resolveToolApproval(deps, call, bashToolEntry, input, trace).optionsPolicy,
    "no-always-allow",
  );
});

test("retained preview waits for the actual broker and does not execute permission hooks", async () => {
  let answer!: (result: PermissionBrokerResult) => void;
  let ready!: () => void;
  const asked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const response = new Promise<PermissionBrokerResult>((resolve) => {
    answer = resolve;
  });
  let hooks = 0;
  const events: unknown[] = [];
  const deps = {
    sessionId: "preview-session",
    turnId: "preview-turn",
    permissionService: new PermissionService(),
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
    emitEvent: async (event: unknown) => {
      events.push(event);
    },
    hookRunner: {
      run: async () => {
        hooks++;
        return { additionalContexts: [], permissionBehavior: "allow" };
      },
    },
    permissionBroker: {
      requestPermission: (request: PermissionBrokerRequest) => {
        assert.equal(request.optionsPolicy, "no-always-allow");
        ready();
        return response;
      },
    },
  } as unknown as ToolExecutorDeps;
  let settled = false;
  const pending = resolveToolPermission(
    deps,
    call,
    bashToolEntry,
    input,
    { additionalContexts: [], permissionBehavior: "allow" },
    "yolo",
    trace,
  ).then((result) => {
    settled = true;
    return result;
  });
  await asked;
  await Promise.resolve();
  assert.equal(hooks, 0);
  assert.equal(settled, false);
  const broadGrant = [
    { type: "addRules" as const, behavior: "allow" as const, rules: [{ toolName: "Bash" }] },
  ];
  answer({
    decision: "allow",
    permissionUpdates: broadGrant,
    sessionPermissionUpdates: broadGrant,
  });
  assert.equal((await pending).allowed, true);
  assert.equal(events.length, 2);
  const temporary = { ...input, keep_alive_after_task: false };
  assert.equal(
    deps.permissionService.checkPermission(
      { toolName: "Bash", input: temporary, mode: "build", riskLevel: "high" },
      resolveRuntimePermissionCapability(bashToolEntry, temporary, context),
    ).decision,
    "ask",
  );
});

test("ordinary temporary commands retain PermissionRequest hook approval", async () => {
  let hooks = 0;
  const temporary = { ...input, keep_alive_after_task: false };
  const deps = {
    sessionId: "preview-session",
    turnId: "preview-turn",
    permissionService: new PermissionService(),
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
    emitEvent: async () => {},
    permissionBroker: { requestPermission: () => new Promise(() => {}) },
    hookRunner: {
      run: async () => {
        hooks++;
        return { additionalContexts: [], permissionBehavior: "allow" };
      },
    },
  } as unknown as ToolExecutorDeps;
  const result = await resolveToolPermission(
    deps,
    { id: "temporary-call", name: "Bash", input: temporary } as never,
    bashToolEntry,
    temporary,
    { additionalContexts: [] },
    "build",
    trace,
  );
  assert.equal(result.allowed, true);
  assert.equal(hooks, 1);
});

test("retention denial and missing broker fail closed", async () => {
  const deps = {
    sessionId: "preview-session",
    turnId: "preview-turn",
    permissionService: new PermissionService(),
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
    emitEvent: async () => {},
  } as unknown as ToolExecutorDeps;
  assert.equal(
    (
      await resolveToolPermission(
        deps,
        call,
        bashToolEntry,
        input,
        { additionalContexts: [] },
        "yolo",
        trace,
      )
    ).allowed,
    false,
  );
  deps.permissionBroker = { requestPermission: async () => ({ decision: "deny" }) };
  assert.equal(
    (
      await resolveToolPermission(
        deps,
        call,
        bashToolEntry,
        input,
        { additionalContexts: [] },
        "yolo",
        trace,
      )
    ).allowed,
    false,
  );
});

test("an automatic hook cannot add retention to a previously approved temporary command", async () => {
  let asks = 0;
  const deps = {
    sessionId: "preview-session",
    permissionService: new PermissionService(),
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
    permissionBroker: {
      requestPermission: async () => {
        asks++;
        return { decision: "allow" };
      },
    },
  } as unknown as ToolExecutorDeps;
  const result = await recheckPermissionHookModifiedInput({
    deps,
    entry: bashToolEntry,
    mode: "yolo",
    modifiedInput: input,
    projectRules: null,
    requestId: "original-request",
    toolCall: call,
    traceContext: trace,
  });
  assert.equal(result.brokerResult?.decision, "deny");
  assert.equal(asks, 0);
});

test("preview prompt defaults to temporary service and limits retention to user requests", () => {
  const description = createBashProviderDescription({
    defaultTimeoutMs: 120000,
    maxTimeoutMs: 600000,
  });
  assert.match(description, /user explicitly/);
  assert.match(description, /keep_alive_after_task.*false/);
});
