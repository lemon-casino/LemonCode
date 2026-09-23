import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  ModelErrorCode,
  type ModelEvent,
  type ModelInputMessage,
  type ModelOptionSpecs,
  type ModelPropertiesInput,
  type ModelResult,
  type ModelToolContract,
} from "@zcode/contracts";
import { createModel, type ModelExecutionRequest, type ModelExecutor } from "./model.js";
import {
  buildActionCode,
  createUiTarsModelExecutor,
  UI_TARS_ACTION_MARKER,
  UI_TARS_MAX_ACTIONS,
} from "./ui-tars-model-executor.js";
import type { UiTarsNormalizedAction } from "./ui-tars-action-codec.js";

const nodeReplTool: ModelToolContract = {
  name: "mcp__node_repl__js",
  inputSchema: { type: "object" },
};

function officialFrame(
  frameId = "frame-1",
  width = 1000,
  height = 500,
  appRef: { pid: number; window_id: number } | null = { pid: 42, window_id: 7 },
  options: {
    role?: ModelInputMessage["role"];
    toolName?: string;
    refOverrides?: Readonly<Record<string, unknown>>;
    imageMediaType?: string;
    includeImage?: boolean;
    adjacent?: boolean;
  } = {},
): ModelInputMessage {
  const imageMediaType = options.imageMediaType ?? "image/png";
  const image = {
    type: "image" as const,
    mediaType: imageMediaType,
    dataUrl: `data:${imageMediaType};base64,cG5n`,
  };
  const ref = {
    type: "text" as const,
    text: JSON.stringify({
      type: "zcode_cua_frame_ref",
      schemaVersion: 1,
      authority: "zcode.cua/open-frame/test",
      frameId,
      contentProtection: "official_cua_frame_v1",
      mimeType: "image/png",
      width,
      height,
      ...(appRef ? { appRef } : {}),
      ...options.refOverrides,
    }),
  };
  const content =
    options.includeImage === false
      ? [ref]
      : options.adjacent === false
        ? [image, { type: "text" as const, text: "not adjacent" }, ref]
        : [image, ref];
  return {
    role: options.role ?? "tool",
    toolCallId: "observe-1",
    toolName: options.toolName ?? nodeReplTool.name,
    content,
  };
}

function request(messages: ModelInputMessage[]): ModelExecutionRequest {
  return {
    messages,
    tools: [nodeReplTool],
    options: { maxOutputTokens: 1024, reasoningLevel: "none" },
  };
}

function executor(result: ModelResult): ModelExecutor & { calls: ModelExecutionRequest[] } {
  const calls: ModelExecutionRequest[] = [];
  return {
    calls,
    async generateText(input) {
      calls.push(input);
      return result;
    },
    async *streamText(input) {
      calls.push(input);
      yield { type: "start" };
      const midpoint = Math.floor(result.text.length / 2);
      yield { type: "text_delta", text: result.text.slice(0, midpoint) };
      yield { type: "text_delta", text: result.text.slice(midpoint) };
      for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
      yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
    },
  };
}

const uiTarsProperties: ModelPropertiesInput = {
  requiresMfjsToolSchema: false,
  contextWindow: 128_000,
  inputFormat: {
    supportsText: true,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: false,
  supportsJsonSchemaOutput: false,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: false,
  interactionProtocol: "ui-tars-text-actions",
};

const optionSpecs: ModelOptionSpecs = {
  reasoningLevel: { values: ["none"], map: "$reasoningLevel" },
  maxOutputTokens: { max: 4096, map: "$maxOutputTokens" },
};

test("createModel enables UI-TARS text actions for a provider without native tool calls", async () => {
  const base = executor({ text: "unused", finishReason: "stop", usage: {} });
  const model = createModel({
    providerId: createModelProviderId("vision-provider"),
    modelId: createModelId("vision-model"),
    properties: uiTarsProperties,
    optionSpecs,
    options: { maxOutputTokens: 1024, reasoningLevel: "none" },
    executor: base,
  });

  const result = await model.generateText({
    messages: [{ role: "user", content: "Open settings" }],
    tools: [nodeReplTool],
  });

  assert.equal(base.calls.length, 0);
  assert.equal(result.finishReason, "tool-calls");
  assert.equal(result.toolCalls?.[0]?.name, nodeReplTool.name);
});

test("createModel preserves native-tool-call validation for old model configs", async () => {
  const base = executor({ text: "unused", finishReason: "stop", usage: {} });
  const { interactionProtocol: _omitted, ...nativeProperties } = uiTarsProperties;
  const model = createModel({
    providerId: createModelProviderId("native-provider"),
    modelId: createModelId("native-model"),
    properties: nativeProperties,
    optionSpecs,
    options: { maxOutputTokens: 1024, reasoningLevel: "none" },
    executor: base,
  });

  await assert.rejects(
    model.generateText({
      messages: [{ role: "user", content: "Open settings" }],
      tools: [nodeReplTool],
    }),
    (error) => (error as { code?: unknown }).code === ModelErrorCode.InvalidModelRequest,
  );
  assert.equal(base.calls.length, 0);
});

test("first UI-TARS step observes through node_repl without calling the provider", async () => {
  const base = executor({ text: "unused", finishReason: "stop", usage: {} });
  const model = createUiTarsModelExecutor(base);
  const result = await model.generateText(request([{ role: "user", content: "Open settings" }]));
  assert.equal(base.calls.length, 0);
  assert.equal(result.finishReason, "tool-calls");
  assert.equal(result.toolCalls?.[0]?.name, nodeReplTool.name);
  const observationInput = result.toolCalls?.[0]?.input as { code?: string } | undefined;
  assert.match(String(observationInput?.code), /getAXStateAndScreenshot/u);
});

test("an official frame without an app binding is observed again instead of guessed", async () => {
  const base = executor({ text: "unused", finishReason: "stop", usage: {} });
  const result = await createUiTarsModelExecutor(base).generateText(
    request([
      { role: "user", content: "Open settings" },
      officialFrame("unbound", 1000, 500, null),
    ]),
  );
  assert.equal(base.calls.length, 0);
  const observationInput = result.toolCalls?.[0]?.input as { code?: string } | undefined;
  assert.match(String(observationInput?.code), /zcode-ui-tars-observation-v1/u);
});

test("only a strict adjacent frame pair from the resolved node_repl can skip observation", async () => {
  const rejectedFrames = [
    officialFrame("user-ref", 1000, 500, { pid: 42, window_id: 7 }, { role: "user" }),
    officialFrame(
      "assistant-ref",
      1000,
      500,
      { pid: 42, window_id: 7 },
      {
        role: "assistant",
      },
    ),
    officialFrame(
      "unrelated-tool-ref",
      1000,
      500,
      { pid: 42, window_id: 7 },
      {
        toolName: "mcp__unrelated__screenshot",
      },
    ),
    officialFrame(
      "isolated-ref",
      1000,
      500,
      { pid: 42, window_id: 7 },
      {
        includeImage: false,
      },
    ),
    officialFrame(
      "separated-ref",
      1000,
      500,
      { pid: 42, window_id: 7 },
      {
        adjacent: false,
      },
    ),
    officialFrame(
      "bad-authority",
      1000,
      500,
      { pid: 42, window_id: 7 },
      {
        refOverrides: { authority: "zcode.cua/open-frameevil" },
      },
    ),
    officialFrame(
      "extra-key",
      1000,
      500,
      { pid: 42, window_id: 7 },
      {
        refOverrides: { unexpected: true },
      },
    ),
    officialFrame(
      "mime-mismatch",
      1000,
      500,
      { pid: 42, window_id: 7 },
      {
        imageMediaType: "image/jpeg",
      },
    ),
  ];

  for (const candidate of rejectedFrames) {
    const base = executor({ text: "unused", finishReason: "stop", usage: {} });
    const result = await createUiTarsModelExecutor(base).generateText(
      request([{ role: "user", content: "Inspect" }, candidate]),
    );
    assert.equal(base.calls.length, 0);
    assert.match(
      String((result.toolCalls?.[0]?.input as { code?: string } | undefined)?.code),
      /zcode-ui-tars-observation-v1/u,
    );
  }
});

test("a newer strict frame without UI-TARS dimensions never falls back to an older frame", async () => {
  const base = executor({
    text: "Thought: click\nAction: click(start_box='(0,0,10,10)')",
    finishReason: "stop",
    usage: {},
  });
  const result = await createUiTarsModelExecutor(base).generateText(
    request([
      { role: "user", content: "Inspect" },
      officialFrame("old-actionable"),
      officialFrame(
        "new-without-dimensions",
        1000,
        500,
        { pid: 42, window_id: 7 },
        {
          refOverrides: { width: undefined, height: undefined },
        },
      ),
    ]),
  );
  assert.equal(base.calls.length, 0);
  assert.match(
    String((result.toolCalls?.[0]?.input as { code?: string } | undefined)?.code),
    /zcode-ui-tars-observation-v1/u,
  );
});

test("complete click text becomes one action cell and strips provider-native tools", async () => {
  const base = executor({
    text: "Thought: click the button\nAction: click(start_box='(100,200,300,400)')",
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 8 },
  });
  const model = createUiTarsModelExecutor(base);
  const result = await model.generateText(
    request([{ role: "user", content: "Continue" }, officialFrame("frame-click")]),
  );
  assert.equal(base.calls.length, 1);
  assert.equal(base.calls[0]?.tools, undefined);
  assert.equal(result.toolCalls?.length, 1);
  const input = result.toolCalls?.[0]?.input as { code: string; title: string };
  assert.match(input.code, new RegExp(UI_TARS_ACTION_MARKER, "u"));
  assert.match(input.code, /frame-click/u);
  assert.match(input.code, /"x":200/u);
  assert.match(input.code, /"y":150/u);
  assert.match(input.code, /"pid":42/u);
  assert.match(input.code, /"window_id":7/u);
  assert.doesNotMatch(input.code, /app\.active/u);
  assert.doesNotMatch(input.code, /computerUse\.getApp/u);
  assert.match(input.code, /computer\.get_app_state/u);
  assert.match(input.code, /app_ref: __zcodeAppRef/u);
  assert.match(input.code, /include_screenshot: true/u);
  assert.equal(result.usage.inputTokens, 12);
});

test("an action newer than the latest frame forces a fresh observation", async () => {
  const base = executor({ text: "unused", finishReason: "stop", usage: {} });
  const priorAction = buildActionCode(
    {
      name: "left_click",
      parameters: { x: 1, y: 2, mouse_button: "left", click_count: 1 },
    },
    "old-frame",
    { pid: 42, window_id: 7 },
  );
  const result = await createUiTarsModelExecutor(base).generateText(
    request([
      { role: "user", content: "Continue" },
      officialFrame("old-frame"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "action-1", name: nodeReplTool.name, input: { code: priorAction } }],
      },
      { role: "tool", toolCallId: "action-1", toolName: nodeReplTool.name, content: "failed" },
    ]),
  );
  assert.equal(base.calls.length, 0);
  const observationInput = result.toolCalls?.[0]?.input as { code?: string } | undefined;
  assert.match(String(observationInput?.code), /zcode-ui-tars-observation-v1/u);
});

test("a new user turn forces generate and stream to observe after the prior frame", async () => {
  const messages: ModelInputMessage[] = [
    { role: "user", content: "Old turn" },
    officialFrame("prior-turn-frame"),
    { role: "user", content: "The desktop may have changed" },
  ];

  const generateBase = executor({ text: "unused", finishReason: "stop", usage: {} });
  const generated = await createUiTarsModelExecutor(generateBase).generateText(request(messages));
  assert.equal(generateBase.calls.length, 0);
  assert.match(
    String((generated.toolCalls?.[0]?.input as { code?: string } | undefined)?.code),
    /zcode-ui-tars-observation-v1/u,
  );

  const streamBase = executor({ text: "unused", finishReason: "stop", usage: {} });
  const events: ModelEvent[] = [];
  for await (const event of createUiTarsModelExecutor(streamBase).streamText(request(messages))) {
    events.push(event);
  }
  assert.equal(streamBase.calls.length, 0);
  const toolCall = events.find((event) => event.type === "tool_call");
  assert.match(
    String(
      toolCall?.type === "tool_call"
        ? (toolCall.toolCall.input as { code?: string } | undefined)?.code
        : undefined,
    ),
    /zcode-ui-tars-observation-v1/u,
  );
});

test("finished returns only its final content", async () => {
  const base = executor({
    text: "Thought: done\nAction: finished(content='Complete')",
    finishReason: "stop",
    usage: { totalTokens: 7 },
  });
  const result = await createUiTarsModelExecutor(base).generateText(
    request([{ role: "user", content: "Do it" }, officialFrame()]),
  );
  assert.equal(result.text, "Complete");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.toolCalls, undefined);
});

test("native tool calls conflict with UI-TARS text and fail closed", async () => {
  const base = executor({
    text: "Thought: click\nAction: click(start_box='(0,0,10,10)')",
    finishReason: "stop",
    usage: {},
    toolCalls: [{ id: "native", name: "other", input: {} }],
  });
  await assert.rejects(
    createUiTarsModelExecutor(base).generateText(
      request([{ role: "user", content: "Do it" }, officialFrame()]),
    ),
    (error) => (error as { code?: unknown }).code === ModelErrorCode.InvalidModelResponse,
  );
});

test("generate rejects every non-stop provider termination before creating an action", async () => {
  for (const finishReason of ["length", "content-filter", "tool-calls"]) {
    const base = executor({
      text: "Thought: click\nAction: click(start_box='(0,0,10,10)')",
      finishReason,
      usage: {},
    });
    await assert.rejects(
      createUiTarsModelExecutor(base).generateText(
        request([{ role: "user", content: "Do it" }, officialFrame()]),
      ),
      (error) => (error as { code?: unknown }).code === ModelErrorCode.InvalidModelResponse,
    );
    assert.equal(base.calls.length, 1);
  }
});

test("stream buffers partial Action text before emitting exactly one tool call", async () => {
  const base = executor({
    text: "Thought: scroll\nAction: scroll(start_box='(400,400,600,600)', direction='down')",
    finishReason: "stop",
    usage: { totalTokens: 4 },
  });
  const events: ModelEvent[] = [];
  for await (const event of createUiTarsModelExecutor(base).streamText(
    request([{ role: "user", content: "Scroll" }, officialFrame()]),
  )) {
    events.push(event);
  }
  assert.equal(events.filter((event) => event.type === "tool_call").length, 1);
  assert.equal(events.filter((event) => event.type === "text_delta").length, 0);
  assert.equal(events.at(-1)?.type, "finish");
});

test("stream preserves provider reasoning while translating the UI-TARS action text", async () => {
  const calls: ModelExecutionRequest[] = [];
  const providerReasoning = {
    type: "reasoning" as const,
    text: "provider-authenticated reasoning",
    providerOptions: { anthropic: { signature: "signed" } },
  };
  const base: ModelExecutor = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    async *streamText(input) {
      calls.push(input);
      yield { type: "start" };
      yield {
        type: "reasoning_start",
        id: "provider-reasoning",
        providerMetadata: providerReasoning.providerOptions,
      };
      yield {
        type: "reasoning_delta",
        id: "provider-reasoning",
        text: providerReasoning.text,
        providerMetadata: providerReasoning.providerOptions,
      };
      yield {
        type: "reasoning_end",
        id: "provider-reasoning",
        providerMetadata: providerReasoning.providerOptions,
      };
      yield {
        type: "text_delta",
        text: "Thought: click\nAction: click(start_box='(0,0,10,10)')",
      };
      yield { type: "finish", finishReason: "stop", usage: {} };
    },
  };

  const events: ModelEvent[] = [];
  for await (const event of createUiTarsModelExecutor(base).streamText(
    request([{ role: "user", content: "Click" }, officialFrame()]),
  )) {
    events.push(event);
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(
    events
      .filter((event) => event.type === "reasoning_delta")
      .map((event) => (event.type === "reasoning_delta" ? event.text : "")),
    [providerReasoning.text, "click"],
  );
  const providerReasoningDelta = events.find(
    (event) => event.type === "reasoning_delta" && event.providerMetadata?.anthropic !== undefined,
  );
  assert.equal(providerReasoningDelta?.type, "reasoning_delta");
  if (providerReasoningDelta?.type === "reasoning_delta") {
    assert.deepEqual(providerReasoningDelta.providerMetadata, providerReasoning.providerOptions);
  }
  assert.equal(events.filter((event) => event.type === "tool_call").length, 1);
  assert.equal(events.at(-1)?.type, "finish");
});

test("stream rejects early EOF and non-stop finish without emitting an action", async () => {
  const actionText = "Thought: click\nAction: click(start_box='(0,0,10,10)')";
  const scenarios: ModelEvent[][] = [
    [{ type: "start" }, { type: "text_delta", text: actionText }],
    [
      { type: "start" },
      { type: "text_delta", text: actionText },
      { type: "finish", finishReason: "length", usage: {} },
    ],
    [
      { type: "start" },
      { type: "text_delta", text: actionText },
      { type: "finish", finishReason: "content-filter", usage: {} },
    ],
  ];

  for (const providerEvents of scenarios) {
    const calls: ModelExecutionRequest[] = [];
    const base: ModelExecutor = {
      async generateText() {
        throw new Error("generateText should not be called");
      },
      async *streamText(input) {
        calls.push(input);
        yield* providerEvents;
      },
    };
    const events: ModelEvent[] = [];
    for await (const event of createUiTarsModelExecutor(base).streamText(
      request([{ role: "user", content: "Do it" }, officialFrame()]),
    )) {
      events.push(event);
    }
    assert.equal(calls.length, 1);
    assert.equal(events.filter((event) => event.type === "tool_call").length, 0);
    assert.equal(events.filter((event) => event.type === "error").length, 1);
  }
});

test("the 50-action cap is scoped to the latest user turn", async () => {
  const markedCall = (id: number): ModelInputMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `action-${id}`,
        name: nodeReplTool.name,
        input: { code: `const marker = ${JSON.stringify(UI_TARS_ACTION_MARKER)};` },
      },
    ],
  });
  const base = executor({
    text: "Thought: done\nAction: finished(content='ok')",
    finishReason: "stop",
    usage: {},
  });
  const messages = [
    { role: "user" as const, content: "Old turn" },
    ...Array.from({ length: UI_TARS_MAX_ACTIONS }, (_, index) => markedCall(index)),
    { role: "user" as const, content: "New turn" },
    officialFrame("new-turn-frame"),
  ];
  await createUiTarsModelExecutor(base).generateText(request(messages));
  assert.equal(base.calls.length, 1);

  const capped = executor({ text: "unused", finishReason: "stop", usage: {} });
  const cappedMessages = [
    { role: "user" as const, content: "Current turn" },
    ...Array.from({ length: UI_TARS_MAX_ACTIONS }, (_, index) => markedCall(index)),
    officialFrame("cap-frame"),
  ];
  const result = await createUiTarsModelExecutor(capped).generateText(request(cappedMessages));
  assert.equal(capped.calls.length, 0);
  assert.match(result.text, /50 UI-TARS actions/u);
});

test("generated type action code keeps model text as a JSON literal", () => {
  const action: UiTarsNormalizedAction = {
    name: "type",
    parameters: { content: "'); process.exit(1); //\n中文" },
  };
  const code = buildActionCode(action, "frame-safe", { pid: 42, window_id: 7 });
  assert.doesNotThrow(() => new Function(`return async function generated(){${code}}`));
  assert.match(code, /process\.exit\(1\)/u);
  assert.match(code, /\\n/u);
});

test("generate Thought is visible but omitted from the next provider projection", async () => {
  const firstBase = executor({
    text: "Thought: inspect the target\nAction: wait()",
    finishReason: "stop",
    usage: {},
  });
  const firstMessages: ModelInputMessage[] = [
    { role: "user", content: "Inspect" },
    officialFrame("before-action"),
  ];
  const firstResult = await createUiTarsModelExecutor(firstBase).generateText(
    request(firstMessages),
  );
  assert.equal(firstResult.reasoning?.at(-1)?.text, "inspect the target");

  const providerReasoning = {
    type: "reasoning" as const,
    text: "provider-authenticated reasoning",
    providerOptions: { openai: { itemId: "reasoning-1" } },
  };
  const secondBase = executor({
    text: "Thought: done\nAction: finished(content='done')",
    finishReason: "stop",
    usage: {},
  });
  await createUiTarsModelExecutor(secondBase).generateText(
    request([
      ...firstMessages,
      {
        role: "assistant",
        content: [...(firstResult.reasoning ?? []), providerReasoning],
        toolCalls: firstResult.toolCalls,
      },
      officialFrame("after-action"),
    ]),
  );

  const projectedReasoning = secondBase.calls[0]?.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "reasoning")
      : [],
  );
  assert.deepEqual(projectedReasoning, [providerReasoning]);
});

test("stream Thought is visible but omitted from the next provider projection", async () => {
  const firstBase = executor({
    text: "Thought: inspect the stream target\nAction: wait()",
    finishReason: "stop",
    usage: {},
  });
  const firstMessages: ModelInputMessage[] = [
    { role: "user", content: "Inspect" },
    officialFrame("before-stream-action"),
  ];
  const firstEvents: ModelEvent[] = [];
  for await (const event of createUiTarsModelExecutor(firstBase).streamText(
    request(firstMessages),
  )) {
    firstEvents.push(event);
  }
  const reasoningStart = firstEvents.find((event) => event.type === "reasoning_start");
  const thought = firstEvents
    .filter((event) => event.type === "reasoning_delta")
    .map((event) => (event.type === "reasoning_delta" ? event.text : ""))
    .join("");
  assert.equal(thought, "inspect the stream target");
  const streamedToolCall = firstEvents.find((event) => event.type === "tool_call");
  assert.equal(streamedToolCall?.type, "tool_call");

  const secondBase = executor({
    text: "Thought: done\nAction: finished(content='done')",
    finishReason: "stop",
    usage: {},
  });
  await createUiTarsModelExecutor(secondBase).generateText(
    request([
      ...firstMessages,
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: thought,
            ...(reasoningStart?.type === "reasoning_start" && reasoningStart.providerMetadata
              ? { providerOptions: reasoningStart.providerMetadata }
              : {}),
          },
        ],
        toolCalls: streamedToolCall?.type === "tool_call" ? [streamedToolCall.toolCall] : undefined,
      },
      officialFrame("after-stream-action"),
    ]),
  );

  const projectedThought = secondBase.calls[0]?.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block) => block.type === "reasoning" && block.text === "inspect the stream target",
      ),
  );
  assert.equal(projectedThought, false);
});
