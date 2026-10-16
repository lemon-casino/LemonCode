import { RoutingError, type SharedQuotaCoordinator } from "@lcode/provider";

/** 每页最多 100 个池；失败保留未知，不把本地预览包装成共享额度事实。 */
export async function readApiKeySharedDiagnostics(
  providerId: string,
  poolIds: readonly string[],
  coordinator?: SharedQuotaCoordinator,
) {
  const ids = [...new Set(poolIds)];
  if (ids.length > 100) throw new RoutingError("quota-owner-capacity", { phase: "storage" });
  const readPool = async (poolId: string) => {
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
  };
  const result: Array<Awaited<ReturnType<typeof readPool>>> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= ids.length) return;
        result[index] = await readPool(ids[index]!);
      }
    }),
  );
  return result;
}

export async function readApiKeyRuntimeDiagnostics<
  TOwner,
  TRecovery,
  T extends { items: { quotaPoolId?: string }[] },
>(
  providerId: string,
  localPreview: T,
  client: import("./api-key-shared-client.js").ApiKeySharedQuotaClient | undefined,
  owner: TOwner,
  recovery: TRecovery,
  asOf: number,
) {
  const sharedPools = await readApiKeySharedDiagnostics(
    providerId,
    localPreview.items.flatMap((item) => (item.quotaPoolId ? [item.quotaPoolId] : [])),
    client?.coordinator,
  );
  return {
    asOf,
    localPreview,
    sharedPools,
    owner,
    recovery,
    feedback: client?.diagnostics(providerId),
  };
}
