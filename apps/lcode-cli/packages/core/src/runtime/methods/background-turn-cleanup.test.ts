import assert from "node:assert/strict";
import test from "node:test";
import type { TraceContext, TurnId } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { cleanupTurnBackgroundBash } from "./background.js";

test("turn completion stops only its own non-retained Bash and waits for process settlement", async () => {
  const calls: string[] = [];
  const tasks = {
    owned: { taskId: "owned", type: "local_bash", turnId: "turn-a", isBackgrounded: true, status: "running" },
    preview: { taskId: "preview", type: "local_bash", turnId: "turn-a", isBackgrounded: true, status: "running", keepAliveAfterTask: true },
    prior: { taskId: "prior", type: "local_bash", turnId: "turn-old", isBackgrounded: true, status: "running" },
    agent: { taskId: "agent", type: "local_agent", turnId: "turn-a", isBackgrounded: true, status: "running" },
  };
  const runtime = {
    config: { taskType: "main" },
    rootTraceContext: {} as TraceContext,
    runtimeTaskRegistry: {
      all: () => tasks,
      update: (id: string, patcher: (value: unknown) => unknown) => {
        const current = tasks[id as keyof typeof tasks];
        const next = patcher(current);
        Object.assign(current, next);
        return current;
      },
    },
    stopBackgroundTask: async (id: string) => {
      calls.push(`stop:${id}`);
      return { ok: true, taskId: id, status: "cancelled", type: "local_bash" };
    },
    executionPort: { waitForBackgroundTask: async (id: string) => {
      calls.push(`settled:${id}`);
      return { taskId: id, status: "cancelled", result: { status: "cancelled" } };
    } },
    logger: { info: () => {}, warn: () => {} },
  } as unknown as AgentRuntimeInternal;

  await cleanupTurnBackgroundBash(runtime, "turn-a" as TurnId, {} as TraceContext);
  assert.deepEqual(calls, ["stop:owned", "settled:owned"]);
  assert.equal((tasks.owned as typeof tasks.owned & { cleanupOnTurnComplete?: boolean }).cleanupOnTurnComplete, true);
  assert.equal((tasks.preview as typeof tasks.preview & { cleanupOnTurnComplete?: boolean }).cleanupOnTurnComplete, undefined);
});
