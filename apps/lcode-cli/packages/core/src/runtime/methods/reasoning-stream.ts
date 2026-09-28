import type { ModelReasoningContentBlock } from "../deps.js";

const DEFAULT_REASONING_STREAM_ID = "__lcode_default_reasoning__";

export function getOrCreateReasoningBlock(input: {
  id?: string;
  providerMetadata?: Record<string, unknown>;
  reasoning: ModelReasoningContentBlock[];
  reasoningById: Map<string, ModelReasoningContentBlock>;
}): ModelReasoningContentBlock {
  const id = input.id ?? DEFAULT_REASONING_STREAM_ID;
  const existing = input.reasoningById.get(id);
  if (existing) {
    return existing;
  }

  // Anthropic-compatible providers can emit thinking deltas without a
  // distinct start event. Preserve the block so later tool_result requests can
  // replay assistant thinking alongside tool_use.
  const block: ModelReasoningContentBlock = {
    type: "reasoning",
    text: "",
    providerOptions: input.providerMetadata,
  };
  input.reasoningById.set(id, block);
  input.reasoning.push(block);
  return block;
}
