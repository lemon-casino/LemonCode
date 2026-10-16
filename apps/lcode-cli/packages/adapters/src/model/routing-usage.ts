import type { ModelUsage } from "@lcode/contracts";
import type { RoutingUsage } from "@lcode/shared";

export function routingUsage(usage: ModelUsage): RoutingUsage {
  const count = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inputTokens = count(usage.inputTokens),
    outputTokens = count(usage.outputTokens);
  const workUnits =
    count(usage.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  return { workUnits, inputTokens, outputTokens };
}
