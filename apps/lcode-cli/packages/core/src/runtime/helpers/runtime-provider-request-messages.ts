import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";

export function buildRuntimeProviderRequestMessages(
  runtime: { readonly config: Pick<AgentRuntimeConfig, "midConversationSystem"> },
  input: {
    entries: readonly RuntimeMessageEntry[];
    applyCacheControl?: boolean;
    model: Model;
  },
): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem =
    runtime.config.midConversationSystem?.mode === "force" ||
    input.model.properties.supportsMidConversationSystem;
  return buildProviderRequestMessages({
    ...input,
    useMidConversationSystem,
  });
}
