import { RoutingError, type SharedQuotaCoordinator } from "@lcode/provider";

/** 每页最多 100 个池；失败保留未知，不把本地预览包装成共享额度事实。 */
export async function readApiKeySharedDiagnostics(
  providerId: string,
  poolIds: readonly string[],
  coordinator?: SharedQuotaCoordinator,
) {
  return Promise.all(
    [...new Set(poolIds)].map(async (poolId) => {
      if (!coordinator) return { poolId, status: "uncoordinated" as const };
      try {
        return {
          poolId,
          status: "known" as const,
          view: await coordinator.inspect(providerId, poolId),
        };
      } catch (error) {
        return {
          poolId,
          status: "unknown" as const,
          error: {
            code: error instanceof RoutingError ? error.code : "quota-owner-unavailable",
            phase: "storage" as const,
          },
        };
      }
    }),
  );
}
