import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type DynamicWorkflowSnippetEvalRequest,
  type ModelTextRequest,
  type ModelTextResult,
} from "@lcode/contracts";
import { evalWorkflowSnippetToolEntry } from "../../tool/handlers/eval-workflow-snippet.js";
import type { ToolEntry } from "../../tool/types.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import { executeTurnCommand } from "./turn.js";

const code = 'return { original: "keep this snippet" };';

for (const mode of ["non-streaming", "end-of-stream", "during-stream"] as const) {
  test(`${mode} repairs actual snippet source fields without replaying a sibling`, async () => {
    const snippets: DynamicWorkflowSnippetEvalRequest[] = [];
    let siblingCalls = 0;
    let modelCalls = 0;
    const { runtime, model, storedEvents } = createMockRuntime(
      {
        mode: "yolo",
        modelStreaming: mode === "non-streaming" ? "off" : "on",
        // Eval 保持非只读，during-stream 只提前执行只读 sibling，不改变工具准入策略。
        streamingToolExecution: mode === "during-stream" ? "readOnly" : "off",
        toolAllowlist: ["EvalWorkflowSnippet", "FixtureRead"],
      },
      undefined,
      undefined,
      {
        dynamicWorkflowSnippetPort: {
          evalSnippet: async (request) => {
            snippets.push(request);
            return { kind: "completed", artifact: { ok: true }, logs: [], logsTruncated: false };
          },
        },
      },
    );
    runtime.registry.register(evalWorkflowSnippetToolEntry, { silentDuplicateWarning: true });
    runtime.registry.register({
      metadata: {
        name: "FixtureRead",
        readOnly: true,
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async () => {
        siblingCalls++;
        return { read: true };
      },
    } as ToolEntry);
    const next = (request: ModelTextRequest): ModelTextResult => {
      modelCalls++;
      assert.ok(modelCalls <= 4, "unexpected automatic replay");
      if (modelCalls === 1)
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            {
              id: "source-conflict-1",
              name: "EvalWorkflowSnippet",
              input: { code, path: "missing.ts", timeoutMs: 5000 },
            },
            { id: "sibling-read", name: "FixtureRead", input: {} },
          ],
        };
      if (modelCalls <= 3) {
        const rejectedId = `source-conflict-${modelCalls - 1}`;
        const feedback = request.messages.find(
          (message) => message.role === "tool" && message.toolCallId === rejectedId,
        );
        assert.ok(feedback?.isError);
        assert.match(JSON.stringify(feedback.content), /Both `code` and `path`/);
        assert.match(JSON.stringify(feedback.content), /REMOVE `path`/);
        assert.match(JSON.stringify(feedback.content), /not executed/i);
        assert.equal(snippets.length, 0);
        assert.equal(siblingCalls, 1);
        // 第二轮故意只换路径，第三轮真正删除 path；均保留原代码和 timeout。
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            {
              id: modelCalls === 2 ? "source-conflict-2" : "source-corrected",
              name: "EvalWorkflowSnippet",
              input:
                modelCalls === 2 ? { code, path: "/", timeoutMs: 5000 } : { code, timeoutMs: 5000 },
            },
          ],
        };
      }
      assert.equal(snippets.length, 1);
      return { text: "fixture recovered", finishReason: "stop", usage: {} };
    };
    model.generateText = async (request) => next(request);
    model.streamText = async function* (request) {
      const response = next(request);
      for (const toolCall of response.toolCalls ?? []) yield { type: "tool_call", toolCall };
      if (response.text) yield { type: "text_delta", text: response.text };
      yield { type: "finish", finishReason: response.finishReason, usage: response.usage };
    };
    assert.equal(
      (await executeTurnCommand.call(runtime, "test the fixture parser", undefined)).response,
      "fixture recovered",
    );
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0]!.code, code);
    assert.equal(snippets[0]!.timeoutMs, 5000);
    assert.equal(siblingCalls, 1);
    assert.equal(
      storedEvents.filter((event) => event.type === SessionEventType.ToolCallError).length,
      2,
    );
    const toolResults = runtime.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .filter((entry) => entry.message?.role === "tool");
    for (const id of [
      "source-conflict-1",
      "source-conflict-2",
      "source-corrected",
      "sibling-read",
    ]) {
      assert.equal(toolResults.filter((entry) => entry.message?.toolCallId === id).length, 1);
    }
  });
}
