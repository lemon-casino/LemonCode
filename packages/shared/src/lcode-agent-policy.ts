import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { LCodeProvider } from "./lcode-task-types-core.js";

export const LCODE_AGENT_PROVIDER = "glm" satisfies LCodeProvider;
export const LCODE_AGENT_PROVIDER_LABEL = "LCode Agent";
export const LCODE_COMMAND_AGENT_SOURCE = "lcodeAgent" satisfies CommandAgentSource;

export const lcodeAgentProviderSchema = z.literal(LCODE_AGENT_PROVIDER);

export const LCODE_COMMAND_AGENT_SOURCES = [
  LCODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToLCodeAgent(
  _provider?: LCodeProvider | null,
): LCodeProvider {
  return LCODE_AGENT_PROVIDER;
}

export function isLCodeAgentProvider(
  provider: LCodeProvider | null | undefined,
): provider is typeof LCODE_AGENT_PROVIDER {
  return provider === LCODE_AGENT_PROVIDER;
}
