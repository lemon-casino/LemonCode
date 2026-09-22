import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJournalStore, type InstanceRef, type WorkflowReportSink } from "@zcode/dynamic-workflow";
import type { AgentRuntime } from "@zcode/core";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";

test("an old cancelled turn cannot fail a retried ask or start alongside it", async () => {
  const turns: { reject: (reason: unknown) => void }[] = [];
  const failed: InstanceRef[] = [];
  const runtime = {
    executeTurn: () => new Promise<never>((_resolve, reject) => {
      turns.push({ reject });
    }),
    closeBrowserSession: async () => {},
  } as unknown as AgentRuntime;
  const journal = new InMemoryJournalStore();
  const sink = {
    askFailed: (instance: InstanceRef) => failed.push(instance),
    askProgress: () => {},
    askStats: () => {},
    askTurnEnded: () => {},
    askSubmitAttempted: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    stopRun: () => {},
    runStalled: () => {},
    concurrencyChanged: () => {},
  } satisfies WorkflowReportSink;
  const deps = {
    runId: "control-test",
    journal,
    emit: () => {},
    runtimeFactory: () => runtime,
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  const driver = createAgentRuntimeWorkflowDriver(deps)(sink);
  const session = await driver.createActorSession({ siteId: "agent#1", ordinal: 1 }, {});
  const first: InstanceRef = { siteId: "ask#1", ordinal: 1 };
  const second: InstanceRef = { ...first, attempt: 2 };
  driver.startAsk(session, first, { instructions: "first", typed: false });
  await Promise.resolve();
  assert.equal(turns.length, 1);
  driver.cancelAsk(first);
  driver.startAsk(session, second, { instructions: "retry", typed: false });
  assert.equal(turns.length, 1, "the same actor runtime must not run two turns at once");
  turns[0]!.reject(new Error("late rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(failed, []);
  assert.equal(turns.length, 2);
  driver.cancelAsk(first);
  turns[1]!.reject(new Error("current failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(failed, [second]);
  driver.dispose?.();
});

test("workflow image refs become actual turn images and missing refs do not start a text-only turn", async () => {
  const calls: unknown[][] = [];
  const failed: InstanceRef[] = [];
  const runtime = {
    executeTurn: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ response: "ok" }); },
    closeBrowserSession: async () => {},
  } as unknown as AgentRuntime;
  const journal = new InMemoryJournalStore();
  const sink = {
    askFailed: (instance: InstanceRef) => failed.push(instance),
    askProgress: () => {}, askStats: () => {}, askTurnEnded: () => {},
    askSubmitAttempted: () => {}, askWaiting: () => {}, askExecuting: () => {},
    askMutating: () => {}, stopRun: () => {}, runStalled: () => {}, concurrencyChanged: () => {},
  } satisfies WorkflowReportSink;
  const deps = {
    runId: "image-test", journal, emit: () => {}, runtimeFactory: () => runtime,
    artifactStore: { readToolResultArtifact: async ({ uri }: { uri: string }) => {
      if (uri.endsWith("missing")) throw new Error("not found");
      return { content: "data:image/png;base64,AA==" };
    } },
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  const driver = createAgentRuntimeWorkflowDriver(deps)(sink);
  const session = await driver.createActorSession({ siteId: "agent#1", ordinal: 1 }, {});
  driver.startAsk(session, { siteId: "ask#1", ordinal: 1 }, {
    instructions: "inspect", typed: false,
    attachments: [{ ref: "zcode-artifact://image", fileName: "image.png", mime: "image/png", bytes: 1 }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((calls[0]?.[1] as Array<{ type: string; content: string }>)[0]?.type, "image");
  assert.equal((calls[0]?.[1] as Array<{ type: string; content: string }>)[0]?.content, "zcode-artifact://image");
  driver.startAsk(session, { siteId: "ask#2", ordinal: 1 }, {
    instructions: "inspect", typed: false,
    attachments: [{ ref: "zcode-artifact://missing", fileName: "missing.png", mime: "image/png", bytes: 1 }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(failed.at(-1)?.siteId, "ask#2");
  driver.dispose?.();
});
