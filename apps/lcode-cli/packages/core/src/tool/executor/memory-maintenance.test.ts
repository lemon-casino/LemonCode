import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationMode } from "@lcode/contracts";
import { PermissionService } from "../../permission/service.js";
import { memoryReviewToolEntry, memorySearchToolEntry } from "../handlers/memory.js";
import { memoryHistoryToolEntry } from "../handlers/memory-history.js";
import { builtInTools } from "../handlers/index.js";
import { resolveRuntimePermissionCapability } from "./permission-capability.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";
import { runPreToolUseHooks, runPostToolUseHooks, runPermissionRequestHooks } from "./hook-flow.js";
import type { ToolExecutorDeps } from "./types.js";

const input = { action: "create", query: "Review durable preferences" };
const scope = { workingDirectory: process.cwd(), workspaceRoot: process.cwd() };

for (const mode of ["yolo", "edit", "build", "plan"] as CollaborationMode[]) {
  test(`enabled memory maintenance does not add a per-item user prompt in ${mode}`, () => {
    const decision = new PermissionService().checkPermission(
      { toolName: "MemoryReview", input, mode, riskLevel: "low" },
      resolveRuntimePermissionCapability(memoryReviewToolEntry, input, scope),
    );
    const result = applyMemoryFilePermission({
      ...scope,
      decision,
      toolName: "MemoryReview",
      executionInput: input,
      memoryRoot: "/memory",
    });
    assert.equal(result.decision, "allow");
    assert.equal(result.alwaysAsk, undefined);
  });
}

test("explicit deny and project ask still override automatic maintenance", () => {
  for (const behavior of ["deny", "ask"] as const) {
    const decision = new PermissionService().checkPermission(
      { toolName: "MemoryReview", input, mode: "build", riskLevel: "low" },
      resolveRuntimePermissionCapability(memoryReviewToolEntry, input, scope),
      { version: 1, [behavior]: [{ toolName: "MemoryReview" }] },
    );
    assert.equal(
      applyMemoryFilePermission({
        ...scope,
        decision,
        toolName: "MemoryReview",
        executionInput: input,
        memoryRoot: "/memory",
      }).decision,
      behavior,
    );
  }
});

test("missing memory or invalid input never gets a managed grant", () => {
  const decision = {
    allowed: false,
    decision: "ask",
    mode: "build",
    ruleId: "mode.build.sideEffect",
  } as const;
  assert.equal(
    applyMemoryFilePermission({
      ...scope,
      decision: decision as never,
      toolName: "MemoryReview",
      executionInput: input,
    }).decision,
    "ask",
  );
  assert.equal(
    applyMemoryFilePermission({
      ...scope,
      decision: decision as never,
      toolName: "MemoryReview",
      executionInput: { action: "create" },
      memoryRoot: "/memory",
    }).decision,
    "ask",
  );
});

test("only supported memory tools register and all skip configured executable hooks", async () => {
  const names = new Set(builtInTools.map((entry) => entry.metadata.name));
  assert.equal(names.has("MemoryReviewApply"), false);
  for (const name of ["MemorySearch", "MemoryReview", "MemoryHistory"])
    assert.equal(names.has(name), true);
  let hooks = 0;
  for (const entry of [memorySearchToolEntry, memoryReviewToolEntry, memoryHistoryToolEntry]) {
    const deps = {
      registry: { get: () => entry },
      hookRunner: {
        run: async () => {
          hooks++;
          return { additionalContexts: [] };
        },
      },
    } as unknown as ToolExecutorDeps;
    const call = { id: "memory-test", name: entry.metadata.name, input };
    await runPreToolUseHooks(deps, call, input, entry, "build", {} as never);
    await runPostToolUseHooks(deps, call, input, {}, undefined, {} as never);
    const permission = await runPermissionRequestHooks(
      deps,
      call,
      input,
      "request_memory",
      { decision: "ask", ruleId: "rule.project.ask" } as never,
      "build",
      {} as never,
    );
    assert.equal(permission, undefined);
  }
  assert.equal(hooks, 0);
});
