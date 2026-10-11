import type { RemoteTarget } from "@lcode/shared";
import { WSLBackend } from "@lcode/server/remote/wsl-backend.js";

type WslTarget = Extract<RemoteTarget, { kind: "wsl" }>;

interface WslIdentityBackend {
  resolveIdentity(): Promise<{ distro: string; user: string }>;
  dispose(): void;
}

interface CanonicalWslTargetResolverOptions {
  createBackend?: (target: WslTarget) => WslIdentityBackend;
  ttlMs?: number;
  now?: () => number;
}

interface CachedResolution {
  expiresAt: number;
  promise: Promise<WslTarget>;
  consumers: number;
  settled: boolean;
  dispose(): void;
}

const DEFAULT_RESOLUTION_TTL_MS = 5_000;
const DEFAULT_IDENTITY_SEGMENT = "<default>";

function buildProvisionalResolutionKey(target: WslTarget): string {
  const distro = target.distro?.trim().toLowerCase() || DEFAULT_IDENTITY_SEGMENT;
  const user = target.user?.trim() || DEFAULT_IDENTITY_SEGMENT;
  return `${distro}\0${user}`;
}

export function createCanonicalWslTargetResolver(
  options: CanonicalWslTargetResolverOptions = {},
): (target: WslTarget, signal?: AbortSignal) => Promise<WslTarget> {
  const createBackend = options.createBackend ?? ((target: WslTarget) => new WSLBackend(target));
  const ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_RESOLUTION_TTL_MS));
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedResolution>();

  return (target, signal) => {
    const cancelled = () => new Error("WSL 身份解析已取消");
    if (signal?.aborted) return Promise.reject(cancelled());
    const key = buildProvisionalResolutionKey(target);
    const cached = cache.get(key);
    let entry = cached && (!cached.settled || cached.expiresAt > now()) ? cached : undefined;
    if (!entry) {
      let backend: WslIdentityBackend | undefined;
      let disposed = false;
      const created: CachedResolution = {
        expiresAt: now() + ttlMs,
        consumers: 0,
        settled: false,
        dispose() {
          if (disposed) return;
          disposed = true;
          backend?.dispose();
        },
        promise: Promise.resolve().then(async () => {
          if (disposed) throw cancelled();
          backend = createBackend(target);
          try {
            const identity = await backend.resolveIdentity();
            if (disposed) throw cancelled();
            return { kind: "wsl" as const, distro: identity.distro, user: identity.user };
          } finally {
            created.settled = true;
            created.dispose();
          }
        }),
      };
      entry = created;
      cache.set(key, entry);
      void entry.promise.catch(() => {
        if (cache.get(key) === created) cache.delete(key);
      });
    }
    const current = entry;
    current.consumers += 1;
    // 缓存中的探测可被多个窗口共享。单个取消只退出自己的等待；最后一个
    // 等待者离开才清理 backend，并按对象身份淘汰缓存，防止旧结果污染重试。
    return new Promise<WslTarget>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", abort);
        current.consumers -= 1;
        if (!current.settled && current.consumers === 0) {
          if (cache.get(key) === current) cache.delete(key);
          current.dispose();
        }
      };
      const abort = () => {
        release();
        reject(cancelled());
      };
      signal?.addEventListener("abort", abort, { once: true });
      current.promise.then(
        (value) => {
          release();
          resolve(value);
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    });
  };
}

export const resolveCanonicalWslTarget = createCanonicalWslTargetResolver();
