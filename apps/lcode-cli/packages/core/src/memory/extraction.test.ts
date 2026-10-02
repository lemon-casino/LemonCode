import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import {
  MEMORY_HISTORY_TOOL_NAME,
  MEMORY_REVIEW_APPLY_TOOL_NAME,
  MEMORY_REVIEW_TOOL_NAME,
  type MessageId,
  type MessageWithParts,
  type ToolPart,
} from "@lcode/contracts";

import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "./extraction.js";

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

for (const tool of ["Write", "Edit"]) {
  for (const status of ["pending", "running", "error", "completed"] as const) {
    test(`${status} ${tool} only skips extraction after a successful completion`, async () => {
      let executions = 0;
      const scheduler = createMemoryExtractionScheduler(async () => {
        executions += 1;
        return "success";
      });
      const snapshot = createSnapshot("remember this preference");
      const assistant = {
        info: { id: "msg_assistant", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool,
            state: { status, input: { file_path: join(snapshot.memoryRoot, "preference.md") } },
          } as ToolPart,
        ],
      } as MessageWithParts;
      snapshot.durableMessages = [...snapshot.durableMessages, assistant];
      snapshot.boundaryMessageId = assistant.info.id;

      scheduler.schedule(snapshot);
      await scheduler.drain();

      assert.equal(executions, status === "completed" ? 0 : 1);
      assert.equal(scheduler.getCursor(), assistant.info.id);
    });
  }
}

test("extraction errors retain the cursor so the same evidence can be retried", async () => {
  let failed = true;
  let executions = 0;
  const scheduler = createMemoryExtractionScheduler(async () => {
    executions += 1;
    return failed ? "error" : "success";
  });
  const snapshot = createSnapshot("remember this preference");
  scheduler.schedule(snapshot);
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), undefined);
  failed = false;
  scheduler.schedule(snapshot);
  await scheduler.drain();
  assert.equal(executions, 2);
  assert.equal(scheduler.getCursor(), snapshot.boundaryMessageId);
});

test("shutdown aborts in-flight extraction, drops pending work and never advances the cursor", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  let executions = 0;
  const scheduler = createMemoryExtractionScheduler(async ({ abortSignal }) => {
    executions += 1;
    started.resolve(abortSignal);
    await new Promise<void>((resolve) =>
      abortSignal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "success";
  });
  scheduler.schedule(createSnapshot("remember this preference"));
  const signal = await started.promise;
  scheduler.schedule(createSnapshot("also remember this", "msg_pending"));
  scheduler.shutdown();
  await scheduler.drain();
  scheduler.schedule(createSnapshot("do not run", "msg_late"));
  assert.equal(signal.aborted, true);
  assert.equal(executions, 1);
  assert.equal(scheduler.getCursor(), undefined);
  assert.equal(scheduler.hasPendingWork(), false);
});

test("extraction prompt requires sequential writes and leaves deletion to an external editor", () => {
  const prompt = buildMemoryExtractionPrompt({ manifest: [], messageCount: 3 });
  assert.doesNotMatch(prompt, /Bash rm|Write\/Edit calls in parallel/u);
  assert.match(prompt, /sequential/iu);
  assert.match(prompt, /external editor/iu);
});

const REVIEW_OPERATIONS = [
  { tool: MEMORY_REVIEW_TOOL_NAME, input: { action: "create" } },
  { tool: MEMORY_REVIEW_TOOL_NAME, input: { action: "read" } },
  { tool: MEMORY_REVIEW_APPLY_TOOL_NAME, input: {} },
  { tool: MEMORY_HISTORY_TOOL_NAME, input: { action: "undo" } },
];

function reviewMessages(
  tool = MEMORY_REVIEW_TOOL_NAME,
  input: Record<string, unknown> = { action: "create" },
): MessageWithParts[] {
  return [
    createSnapshot("please review preferences", "msg_review_user").durableMessages[0]!,
    {
      info: { id: "msg_review_tool", role: "assistant" },
      parts: [
        { type: "tool", tool, state: { status: "error", input, error: "rejected proposal" } },
      ],
    } as MessageWithParts,
    {
      info: { id: "msg_synthetic_notice", role: "user", synthetic: true },
      parts: [{ type: "text", text: "proposed incorrect preference" }],
    } as MessageWithParts,
    {
      info: { id: "msg_model_only_notice", role: "user", visibility: "model-only" },
      parts: [{ type: "text", text: "do not retain proposal" }],
    } as MessageWithParts,
    {
      info: { id: "msg_review_answer", role: "assistant" },
      parts: [{ type: "text", text: "The rejected proposal says use the unsafe preference." }],
    } as MessageWithParts,
  ];
}

for (const { tool, input } of REVIEW_OPERATIONS) {
  test(`${tool} ${"action" in input ? input.action : "apply"} tail consumes the boundary without extraction`, async () => {
    let executions = 0;
    const scheduler = createMemoryExtractionScheduler(async () => {
      executions += 1;
      return "success";
    });
    const messages = reviewMessages(tool, input);
    const snapshot = {
      ...createSnapshot("fixture"),
      durableMessages: messages,
      boundaryMessageId: messages.at(-1)!.info.id,
    };
    scheduler.schedule(snapshot);
    await scheduler.drain();
    assert.equal(executions, 0);
    assert.equal(scheduler.getCursor(), snapshot.boundaryMessageId);
  });
}

for (const coldStart of [true, false]) {
  test(`review evidence is excluded on a later ordinary turn (coldStart=${coldStart})`, async () => {
    const captured: MemoryExtractionSnapshot[] = [];
    const counts: number[] = [];
    const scheduler = createMemoryExtractionScheduler(async ({ snapshot, messageCount }) => {
      captured.push(snapshot);
      counts.push(messageCount);
      return "success";
    });
    const before = createSnapshot("previous ordinary preference", "msg_before");
    if (!coldStart) {
      scheduler.schedule(before);
      await scheduler.drain();
      captured.length = 0;
      counts.length = 0;
    }
    const next = createSnapshot("remember the safe preference", "msg_after");
    const messages = [...before.durableMessages, ...reviewMessages(), ...next.durableMessages];
    scheduler.schedule({ ...next, durableMessages: messages });
    await scheduler.drain();
    assert.equal(captured.length, 1);
    assert.deepEqual(
      captured[0]!.durableMessages.map((message) => message.info.id),
      [next.boundaryMessageId],
    );
    assert.deepEqual(counts, [1]);
    assert.equal(scheduler.getCursor(), next.boundaryMessageId);
    assert.equal(messages.length, 7, "filtering must not mutate durable history");
  });
}

test("synthetic and model-only user messages never end the excluded review turn", async () => {
  let executions = 0;
  const scheduler = createMemoryExtractionScheduler(async () => {
    executions += 1;
    return "success";
  });
  const messages = reviewMessages();
  // 即便 ToolPart 所在消息仅供模型使用，仍需据此隔离；不能从 UI 可见性猜轮次。
  messages[1]!.info.semantics = {
    origin: "agent_runtime",
    kind: "assistant_response",
    uiVisibility: "hidden",
    providerVisibility: "visible",
    transcriptVisibility: "hidden",
  };
  scheduler.schedule({
    ...createSnapshot("fixture"),
    durableMessages: messages,
    boundaryMessageId: messages.at(-1)!.info.id,
  });
  await scheduler.drain();
  assert.equal(executions, 0);
  assert.equal(scheduler.getCursor(), messages.at(-1)!.info.id);
});

test("derived compact summaries and synthetic text parts do not reopen a review turn", async () => {
  const captured: MemoryExtractionSnapshot[] = [];
  const scheduler = createMemoryExtractionScheduler(async ({ snapshot }) => {
    captured.push(snapshot);
    return "success";
  });
  const compact = {
    info: { id: "msg_compact", role: "user", summary: { body: "proposal", diffs: [] } },
    parts: [
      { type: "text", synthetic: true, text: "proposal compact summary" },
      { type: "compaction" },
    ],
  } as MessageWithParts;
  const synthetic = {
    info: { id: "msg_part_synthetic", role: "user" },
    parts: [{ type: "text", synthetic: true, text: "proposal synthetic continuation" }],
  } as MessageWithParts;
  const review = reviewMessages();
  scheduler.schedule({
    ...createSnapshot("fixture"),
    durableMessages: [...review, compact, synthetic],
    boundaryMessageId: synthetic.info.id,
  });
  await scheduler.drain();
  assert.equal(captured.length, 0);
  assert.equal(scheduler.getCursor(), synthetic.info.id);

  const next = createSnapshot("remember a safe preference", "msg_after_compact");
  scheduler.schedule({
    ...next,
    durableMessages: [...review, ...next.durableMessages, compact],
    boundaryMessageId: compact.info.id,
  });
  await scheduler.drain();
  assert.equal(captured.length, 1);
  assert.deepEqual(
    captured[0]!.durableMessages.map((message) => message.info.id),
    [next.boundaryMessageId],
  );
});

test("history list and literal review names leave ordinary extraction unchanged", async () => {
  const captured: MemoryExtractionSnapshot[] = [];
  const scheduler = createMemoryExtractionScheduler(async ({ snapshot }) => {
    captured.push(snapshot);
    return "success";
  });
  const snapshot = createSnapshot("MemoryReview create is only literal text");
  const listMessage = {
    info: { id: "msg_lists", role: "assistant" },
    parts: [MEMORY_HISTORY_TOOL_NAME].map((tool) => ({
      type: "tool",
      tool,
      state: { status: "completed", input: { action: "list" } },
    })),
  } as MessageWithParts;
  snapshot.durableMessages = [...snapshot.durableMessages, listMessage];
  snapshot.boundaryMessageId = listMessage.info.id;
  scheduler.schedule(snapshot);
  await scheduler.drain();
  assert.equal(captured.length, 1);
  assert.equal(captured[0], snapshot);
});

test("review list summaries cannot feed back as durable facts", async () => {
  let executions = 0;
  const scheduler = createMemoryExtractionScheduler(async () => {
    executions++;
    return "success";
  });
  const snapshot = createSnapshot("List old review proposals");
  const reply = {
    info: { id: "msg_unaccepted_summary", role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: MEMORY_REVIEW_TOOL_NAME,
        state: { status: "completed", input: { action: "list" } },
      },
      { type: "text", text: "UNACCEPTED_PROPOSAL_FACT" },
    ],
  } as MessageWithParts;
  snapshot.durableMessages = [...snapshot.durableMessages, reply];
  snapshot.boundaryMessageId = reply.info.id;
  scheduler.schedule(snapshot);
  await scheduler.drain();
  assert.equal(executions, 0);
  assert.equal(scheduler.getCursor(), reply.info.id);
});

function createSnapshot(text: string, id = "msg_user"): MemoryExtractionSnapshot {
  const message = {
    info: { id: id as MessageId, role: "user" },
    parts: [{ type: "text", text }],
  } as MessageWithParts;
  return {
    boundaryMessageId: message.info.id,
    durableMessages: [message],
    memoryRoot: resolve("memory-fixture"),
    workingDirectory: resolve("workspace-fixture"),
    workspaceRoot: resolve("workspace-fixture"),
  };
}
