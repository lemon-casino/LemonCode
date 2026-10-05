import type { Model, ModelStreamEvent, SessionEvent, SessionId, TraceContext } from "../deps.js";
import { createSessionId } from "../deps.js";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";

export function createMockRuntime(
  config: AgentRuntimeConfig = {},
  stream: () => AsyncIterable<ModelStreamEvent> = async function* () {
    yield { type: "text_start", id: "answer" };
    yield { type: "text_delta", id: "answer", text: "Mock result" };
    yield { type: "text_end", id: "answer" };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } };
  },
  sessionId: SessionId = createSessionId(),
): { runtime: AgentRuntimeInternal; model: Model; storedEvents: SessionEvent[] } {
  const storedEvents: SessionEvent[] = [];
  const model = {
    providerId: "test-provider",
    modelId: "test-model",
    options: {},
    optionSpecs: { maxOutputTokens: { max: 4096 }, reasoningLevel: { values: [] } },
    properties: {
      contextWindow: 128_000,
      inputFormat: {
        supportsAudio: false,
        supportsImage: true,
        supportsPdf: true,
        supportsText: true,
        supportsVideo: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsMidConversationSystem: true,
    },
    streamText: stream,
    generateText: async () => ({ text: "Mock result", finishReason: "stop", usage: {} }),
  } as unknown as Model;
  const runtime = new AgentRuntime(
    sessionId,
    {
      compact: { enabled: false },
      memory: { enabled: false },
      mcp: { enabled: false },
      subagents: { enabled: false },
      titleGeneration: { enabled: false },
      modelSelection: { providerId: model.providerId, modelId: model.modelId },
      modelStreaming: "on",
      toolAllowlist: [],
      ...config,
    },
    {
      modelFactory: () => model,
      eventStore: {
        append: async (event: SessionEvent) => {
          const stored = { ...event, sequenceNumber: storedEvents.length + 1 };
          storedEvents.push(stored);
          return stored;
        },
        getEvents: async () => storedEvents,
      } as never,
    },
  ) as unknown as AgentRuntimeInternal;
  runtime.ensureContextInitialized = async function (_trace: TraceContext, _model?: Model) {
    this.contextInitialized = true;
  };
  return { model, runtime, storedEvents };
}
