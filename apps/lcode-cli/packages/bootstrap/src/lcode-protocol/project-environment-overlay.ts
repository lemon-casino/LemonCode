import {
  lcodeProtocolMethods,
  runtimeEnvironmentResolveContextResultSchema,
} from "@lcode/shared";
import type { ExecutionEnvOverlay } from "@lcode/contracts";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import type { ProjectEnvironmentOverlayResolver } from "../app/project-environment-execution.js";

/**
 * CLI 侧环境 overlay 解析器（spec: specs/worktree-runtime-environments.md §9.3，P2-03）。
 * 每次真实 spawn 前按 cwd 向目标 Host 解析所属托管环境；无命中/旧 Host 不支持时返回
 * undefined，保持非托管继承语义（不报错、不阻塞）。
 */

/** 短时缓存：revision 变化经 TTL 生效；在途命令不受影响（spec §6.2/§9.3）。 */
const OVERLAY_CACHE_TTL_MS = 5_000;
const OVERLAY_CACHE_LIMIT = 256;

export function createProjectEnvironmentOverlayResolver(
  context: Pick<LCodeProtocolAgentServerContext, "requestClient">,
): ProjectEnvironmentOverlayResolver {
  const cache = new Map<string, { overlay?: ExecutionEnvOverlay; expiresAt: number }>();
  return async (cwd) => {
    if (!cwd) return undefined;
    const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.overlay;
    let overlay: ExecutionEnvOverlay | undefined;
    try {
      const result = await context.requestClient(
        lcodeProtocolMethods.runtimeEnvironmentResolveContext,
        { cwd, consumer: "execution" },
        runtimeEnvironmentResolveContextResultSchema,
        { timeoutMs: 3_000 },
      );
      const wire = result.context;
      if (wire && (wire.envOverlay.set || wire.envOverlay.unset || wire.envOverlay.base)) {
        overlay = {
          ...(wire.envOverlay.base ? { base: wire.envOverlay.base } : {}),
          ...(wire.envOverlay.set ? { set: wire.envOverlay.set } : {}),
          ...(wire.envOverlay.unset ? { unset: wire.envOverlay.unset } : {}),
        };
      }
    } catch {
      // 旧 Host method-not-found / 无 Host 连接 / 解析失败：非托管语义，不阻塞 spawn。
      overlay = undefined;
    }
    if (cache.size >= OVERLAY_CACHE_LIMIT) cache.clear();
    cache.set(key, { ...(overlay ? { overlay } : {}), expiresAt: now + OVERLAY_CACHE_TTL_MS });
    return overlay;
  };
}
