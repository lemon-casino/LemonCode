import { lcodeProviderUsageStatsParamsSchema } from "@lcode/shared";
import type { UsageStorePort } from "@lcode/contracts";
import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

export async function getProviderUsageStats(
  context: LCodeProtocolAgentServerContext,
  raw: unknown,
) {
  const request = parseParams(lcodeProviderUsageStatsParamsSchema, raw);
  const store = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  // 数据源缺失不是零用量；让 UI 保留明确的不可用状态。
  if (!store?.queryProviderUsage) throw new Error("provider_usage_unavailable");
  const until = Date.now();
  const days = request.range === "24h" ? 1 : request.range === "7d" ? 7 : 30;
  // 累计读取实际保留账本；有界日趋势由查询层生成，不能从Unix epoch补零。
  return store.queryProviderUsage({
    ...request,
    since: request.range === "all" ? 0 : until - days * 86400000,
    until,
  });
}
