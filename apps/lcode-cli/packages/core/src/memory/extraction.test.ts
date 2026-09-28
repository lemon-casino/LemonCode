import assert from "node:assert/strict";
import test from "node:test";
import type { MessageId, MessageWithParts } from "@lcode/contracts";

import { createMemoryExtractionScheduler, type MemoryExtractionSnapshot } from "./extraction.js";

test("Chinese prose without spaces is admitted after three Han characters", async () => {
  let executions = 0;
  const scheduler = createMemoryExtractionScheduler(async () => {
    executions += 1;
    return "success";
  });

  scheduler.schedule(createSnapshot("请记住"));
  await scheduler.drain();

  assert.equal(executions, 1);
});

test("English admission keeps the three whitespace-delimited word threshold", async () => {
  let executions = 0;
  const scheduler = createMemoryExtractionScheduler(async () => {
    executions += 1;
    return "success";
  });

  scheduler.schedule(createSnapshot("only two", "msg_first"));
  await scheduler.drain();
  scheduler.schedule(createSnapshot("now there are three", "msg_second"));
  await scheduler.drain();

  assert.equal(executions, 1);
});

function createSnapshot(text: string, id = "msg_user"): MemoryExtractionSnapshot {
  const message = {
    info: { id: id as MessageId, role: "user" },
    parts: [{ type: "text", text }],
  } as MessageWithParts;
  return {
    boundaryMessageId: message.info.id,
    durableMessages: [message],
    memoryRoot: "/memory",
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
  };
}
