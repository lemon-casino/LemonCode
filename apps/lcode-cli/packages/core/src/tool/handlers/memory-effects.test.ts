import assert from "node:assert/strict";
import test from "node:test";
import { memoryHistoryToolEntry } from "./memory-history.js";
import { reviewHarness } from "../../memory/review-test-fixtures.js";
import { memoryEffectWorkspaceKey } from "../../memory/effect-observation.js";

test("explicit feedback uses per-call user approval; effects diagnostics are read-only", async () => {
  const input = {
    action: "feedback",
    effectSessionId: "fixture-session",
    effectTurnId: "fixture-turn",
    fileName: "fact.md",
    expectedHash: `sha256:${"a".repeat(64)}`,
    feedback: "correction",
  };
  const h = reviewHarness();
  const feedback = memoryHistoryToolEntry.resolvePermissionCapability!(input, h.context);
  assert.equal(feedback?.permission.alwaysAsk, true);
  assert.equal(feedback?.permission.approvalSource, "user");
  assert.equal(feedback?.permission.askOptions?.allowAlways, false);
  assert.equal(
    memoryHistoryToolEntry.resolvePermissionCapability!({ action: "effects" }, h.context)?.readOnly,
    true,
  );
  for (const patch of [
    { automationTurn: true },
    { offPeakTurn: true },
    { runtimeScope: "subagent" as const },
  ]) {
    h.context.fileSystemPort!.projectMemory = {
      effects: {
        recordFeedback: async () => {
          throw new Error("must not reach feedback writer");
        },
      },
    } as never;
    await assert.rejects(
      memoryHistoryToolEntry.handler(input, { ...h.context, ...patch }),
      /unavailable/u,
    );
  }
});

test("effect diagnostics use the registered memory identity rather than a distinct execution binding", async () => {
  const h = reviewHarness();
  h.context.workspaceIdentity = "execution-binding";
  h.context.memoryWorkspaceIdentity = "memory-owner";
  let readScope;
  h.context.fileSystemPort!.projectMemory = {
    effects: {
      read: async (input: { workspaceKey: string }) => {
        readScope = input.workspaceKey;
        return {};
      },
    },
  } as never;
  await memoryHistoryToolEntry.handler({ action: "effects" }, h.context);
  assert.equal(readScope, memoryEffectWorkspaceKey("memory-owner", h.context.workspaceRoot));
});
