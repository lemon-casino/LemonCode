import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "@lcode/shared";

// 与 packages/server/src/hostCapability.ts 保持一致的一次性短期 ticket 语义。
// 依赖边界禁止从 @lcode/server 的入口导入实现，因此在新包内保留一份等价的
// 纯内存实现，行为以旧 server 的兼容合同为准（TTL、一次性消费、过期清理）。
export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

export interface HostCapabilityStore {
  issue(): ServerRemoteHostCapability;
  consume(capability: string | undefined): boolean;
}

/** 短期、一次性 desktop host capability；只在 Server Core 进程内存中存在。 */
export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const expiresByCapability = new Map<string, number>();

  const purgeExpired = (at: number): void => {
    for (const [capability, expiresAt] of expiresByCapability) {
      if (expiresAt <= at) expiresByCapability.delete(capability);
    }
  };

  return {
    issue() {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      expiresByCapability.set(capability, expiresAt);
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return false;
      const consumedAt = now();
      const expiresAt = expiresByCapability.get(capability);
      // ticket 无论成功、过期还是重放都先删除，只有首次且 TTL 内的消费能获得
      // trusted-host role，避免可重放的长期提权声明。
      expiresByCapability.delete(capability);
      purgeExpired(consumedAt);
      return expiresAt !== undefined && expiresAt > consumedAt;
    },
  };
}
