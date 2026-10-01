import type { LCodeContextUsageBreakdownItem } from "@lcode/shared";

type ContextUsageBreakdownSource = LCodeContextUsageBreakdownItem["source"];

const CONTEXT_BREAKDOWN_TONE_BY_SOURCE: Record<ContextUsageBreakdownSource, string> = {
  system_tool_schemas: "var(--color-usage-chart-1)",
  system_prompt: "var(--color-usage-chart-3)",
  messages: "var(--color-usage-chart-2)",
  meta_user_context: "var(--color-usage-chart-5)",
  skills: "var(--color-usage-chart-4)",
  mcp_tool_schemas: "var(--color-usage-chart-6)",
  tool_prompt: "color-mix(in oklab, var(--color-usage-chart-4) 62%, var(--color-usage-chart-5))",
};

export function getContextBreakdownTone(source: ContextUsageBreakdownSource): string {
  return CONTEXT_BREAKDOWN_TONE_BY_SOURCE[source];
}
