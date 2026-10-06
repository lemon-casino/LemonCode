import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type ModelTextRequest, type ModelTextResult } from "@lcode/contracts";
import type { ToolEntry } from "../../tool/types.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import { executeTurnCommand } from "./turn.js";

const toolName = "FixtureWrite";

test("legacy nested and flat model results retain the parse failure at extraction", () => {
  const { runtime } = createMockRuntime();
  const call = {
    id: "malformed-call",
    name: toolName,
    input: {},
    inputError: { code: "invalid_json", inputLength: 5974 },
  };
  for (const result of [{ toolCalls: [call] }, { responses: [{ toolCalls: [call] }] }]) {
    assert.deepEqual(runtime.extractToolCallsFromResult(result)[0].inputError, call.inputError);
  }
});

for (const mode of ["non-streaming", "end-of-stream", "during-stream"] as const) {
  test(`${mode} carries the parse failure through the session loop and executes only the corrected call`, async () => {
    let requests = 0;
    let actions = 0;
    const { runtime, model, storedEvents } = createMockRuntime({
      modelStreaming: mode === "non-streaming" ? "off" : "on",
      streamingToolExecution: mode === "during-stream" ? "readOnly" : "off",
      toolAllowlist: [toolName],
    });
    runtime.registry.register({
      metadata: {
        name: toolName,
        readOnly: true,
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      // 宽松 schema 证明拒绝依赖解析事实，而非碰巧缺少某个工具必填字段。
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => {
        actions++;
        return {};
      },
    } as ToolEntry);
    function next(request: ModelTextRequest): ModelTextResult {
      requests++;
      assert.ok(requests <= 3, "unexpected model retry/replay");
      if (requests === 1)
        return {
          text: "",
          finishReason: "error",
          usage: {},
          toolCalls: [
            {
              id: "malformed-call",
              name: toolName,
              input: {},
              inputError: { code: "invalid_json", inputLength: 5974 },
            },
          ],
        };
      if (requests === 2) {
        const feedback = request.messages.find(
          (message) => message.role === "tool" && message.toolCallId === "malformed-call",
        );
        assert.ok(feedback?.isError);
        assert.match(JSON.stringify(feedback.content), /invalid or incomplete JSON/);
        assert.doesNotMatch(
          JSON.stringify(feedback.content),
          /required parameter|max_tokens|output limit/,
        );
        assert.equal(actions, 0);
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [{ id: "corrected-call", name: toolName, input: {} }],
        };
      }
      return { text: "recovered", finishReason: "stop", usage: {} };
    }
    model.generateText = async (request) => next(request);
    model.streamText = async function* (request) {
      const result = next(request);
      for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
      if (result.text) yield { type: "text_delta", text: result.text };
      yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
    };
    const result = await executeTurnCommand.call(runtime, "write fixture", undefined);
    assert.equal(result.response, "recovered");
    assert.equal(actions, 1);
    assert.equal(requests, 3);
    const failures = storedEvents.filter((event) => event.type === SessionEventType.ToolCallError);
    assert.equal(failures.length, 1);
    assert.match(JSON.stringify(failures[0]), /invalid or incomplete JSON/);
    const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
    const toolResults = entries.filter((entry) => entry.message?.role === "tool");
    assert.equal(
      toolResults.filter((entry) => entry.message?.toolCallId === "malformed-call").length,
      1,
    );
    assert.equal(
      toolResults.filter((entry) => entry.message?.toolCallId === "corrected-call").length,
      1,
    );
  });
}
