import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type ToolOperationAdmissionPort } from "@zcode/contracts";
import { ToolRegistryImpl } from "../registry.js";
import type { ToolEntry } from "../types.js";
import { createToolExecutor } from "./impl.js";
import type { ToolExecutorOptions } from "./types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("admission precedes started events and a timed-out handler retains its operation lease", async () => {
  const firstEntered = deferred();
  const firstDone = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  let calls = 0;
  let busy = false;
  let next: (() => void) | undefined;
  const gate: ToolOperationAdmissionPort = {
    async acquire() {
      if (busy) await new Promise<void>((done) => { next = done; });
      busy = true;
      return () => {
        busy = false;
        next?.();
        next = undefined;
      };
    },
  };
  const registry = new ToolRegistryImpl();
  registry.register({
    metadata: { name: "Edit", riskLevel: "low", sideEffectScope: "workspace", readOnly: false },
    inputSchema: { type: "object", properties: { file_path: { type: "string" } } },
    outputSchema: { type: "object" },
    timeout: { defaultMs: 20, maxMs: 20, allowCallOverride: false },
    cancellation: { supported: true, cleanup: "bestEffort" },
    handler: async () => {
      calls++;
      if (calls === 1) { firstEntered.resolve(); await firstDone.promise; }
      return { done: true };
    },
  } as ToolEntry);
  const executor = createToolExecutor({
    registry,
    permissionService: { checkPermission: () => ({ allowed: true, decision: "allow" }) },
    toolOperationAdmission: gate,
    emitEvent: async (event) => {
      if (event.type === SessionEventType.ToolCallStarted) {
        if (calls === 0) firstStarted.resolve();
        else secondStarted.resolve();
      }
    },
    sessionId: "test" as ToolExecutorOptions["sessionId"],
    getWorkingDirectory: () => process.cwd(),
    getWorkspaceRoot: () => process.cwd(),
    getMode: () => "yolo",
  } as ToolExecutorOptions);
  const first = executor.execute({ id: "tool-a", name: "Edit", input: { file_path: "a" } } as never);
  await firstStarted.promise;
  await firstEntered.promise;
  const timedOut = await first;
  assert.equal(timedOut.success, false);
  const second = executor.execute({ id: "tool-b", name: "Edit", input: { file_path: "a" } } as never);
  await Promise.resolve();
  assert.equal(calls, 1);
  firstDone.resolve();
  await secondStarted.promise;
  assert.equal((await second).success, true);
  assert.equal(calls, 2);
});
