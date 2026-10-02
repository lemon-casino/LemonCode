import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspectTrace, listTraces } from "./analyzer.js";

async function fixture(t: TestContext, events: unknown[], logs: unknown[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "lcode-debug-analyzer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logDir = join(directory, "fixture.log");
  const eventPath = join(directory, "fixture.jsonl");
  await Promise.all([
    writeFile(logDir, logs.map((log) => JSON.stringify(log)).join("\n")),
    writeFile(eventPath, events.map((event) => JSON.stringify(event)).join("\n")),
  ]);
  return { logDir, eventPath, dbPath: join(directory, "absent.sqlite") };
}

function event(id: string, type: string, second: number, payload: unknown = {}, extra = {}) {
  return {
    id,
    type,
    timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    traceId: "trace-fixture",
    sessionId: "session-fixture",
    turnId: "turn-fixture",
    payload,
    ...extra,
  };
}

test("analyzer preserves public arity and timestamp-ordered event correlation", async (t) => {
  assert.equal(listTraces.length, 0);
  assert.equal(inspectTrace.length, 1);
  const events = [
    event("end", "turn_complete", 9, { resultType: "assistant_message" }),
    event("tool-end", "tool_call_result", 7, { toolCallId: "tool-a", toolName: "Read" }),
    event("tool-start", "tool_call_started", 3, { toolCallId: "tool-a", toolName: "Read" }),
    event("wrong-tool", "tool_call_result", 4, { toolCallId: "tool-b" }),
    event("early-tool", "tool_call_result", 2, { toolCallId: "tool-a" }),
    event("start", "turn_started", 1),
    event("other", "turn_started", 0, {}, { traceId: "trace-other", sessionId: "session-other" }),
  ];
  const options = await fixture(t, events, [
    {
      traceId: "trace-fixture",
      sessionId: "session-fixture",
      timestamp: "2026-01-01T00:00:08.000Z",
      event: "storage.write",
      message: "fixture write",
      durationMs: 250,
      status: "completed",
      level: "info",
    },
  ]);
  const detail = await inspectTrace("trace-fixture", options);
  assert.deepEqual(detail.sessions, ["session-fixture"]);
  assert.deepEqual(
    detail.spans.map(({ lane, startAt, endAt, status }) => ({ lane, startAt, endAt, status })),
    [
      {
        lane: "turn",
        startAt: "2026-01-01T00:00:01.000Z",
        endAt: "2026-01-01T00:00:09.000Z",
        status: "ok",
      },
      {
        lane: "tool",
        startAt: "2026-01-01T00:00:03.000Z",
        endAt: "2026-01-01T00:00:07.000Z",
        status: "ok",
      },
      {
        lane: "storage",
        startAt: "2026-01-01T00:00:07.750Z",
        endAt: "2026-01-01T00:00:08.000Z",
        status: "ok",
      },
    ],
  );
  assert.equal(detail.timeline[0]?.id, "event:end");
  assert.equal(detail.timeline.at(-1)?.id, "event:start");
  assert.equal(detail.sources.find((source) => source.kind === "sqlite")?.available, false);
});

test("context and cache projections retain full text, categories and prefix attribution", async (t) => {
  const options = await fixture(
    t,
    [
      event("request", "model_request", 1, {
        model: "fixture-model",
        messages: [
          { role: "system", content: "# System\nfixture\n## Skills\nskill fixture" },
          { role: "user", content: "fixture prompt" },
        ],
      }),
      event("complete", "model_complete", 2, {
        usage: {
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
          cacheReadTokens: 10,
          cacheWriteTokens: 3,
        },
      }),
      event("turn", "turn_complete", 3, { cacheStats: { cachedMessages: 1, lastCacheHit: true } }),
    ],
    [
      {
        traceId: "trace-fixture",
        sessionId: "session-fixture",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: "Context usage snapshot",
        context: {
          totalTokens: 20,
          totalChars: 40,
          tokenMethod: "estimated",
          confidence: "medium",
          tokenizer: "fixture",
          categories: [
            {
              id: "system",
              name: "System",
              source: "system_prompt",
              chars: 40,
              tokens: 20,
              percentTokens: 1,
            },
          ],
          mcpTools: [{ name: "fixture-tool", source: "mcp_tool", tokens: 2 }],
          skills: [{ name: "fixture-skill", tokens: 3 }],
        },
      },
    ],
  );
  const detail = await inspectTrace("trace-fixture", options);
  assert.equal(detail.contextSnapshots[0]?.observationLevel, "full");
  assert.deepEqual(
    detail.contextSnapshots[0]?.sections.map((section) => section.source),
    ["system_prompt", "skills"],
  );
  assert.equal(detail.contextUsageSnapshots[0]?.totalTokens, 20);
  assert.equal(detail.contextUsageSnapshots[0]?.mcpTools[0]?.name, "fixture-tool");
  assert.equal(detail.cacheReports[0]?.hitRate, 0.5);
  assert.deepEqual(
    detail.cacheReports[0]?.segments.map((segment) => segment.status),
    ["hit", "miss"],
  );
  assert.deepEqual(
    detail.developerRequests.map((request) => request.eventName),
    ["prompt_cache_report"],
  );
  const list = await listTraces(options);
  assert.equal(list.traces[0]?.firstUserMessage, "fixture prompt");
  assert.equal(list.traces[0]?.cacheReadTokens, 10);
  assert.equal(list.traces[0]?.cacheWriteTokens, 3);
});

test("trace list keeps descending recency and earliest user text independent of input order", async (t) => {
  const options = await fixture(t, [
    event("late", "user_message", 8, { content: "later prompt" }),
    event("early", "user_message", 2, { content: [{ text: "earliest" }, { text: "prompt" }] }),
    event("other", "user_message", 9, { content: "other prompt" }, { traceId: "trace-other" }),
  ]);
  const list = await listTraces({ ...options, limit: 2 });
  assert.deepEqual(
    list.traces.map((trace) => trace.traceId),
    ["trace-other", "trace-fixture"],
  );
  assert.equal(list.traces[1]?.firstUserMessage, "earliest prompt");
});
