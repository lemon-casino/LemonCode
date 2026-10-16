import { applySharedRecoveryFeedback } from "./api-key-shared-quota-feedback.js";
import {
  claimSharedProbe,
  cancelSharedProbes,
  sharedNeedsProbe,
} from "./api-key-shared-quota-probes.js";
import { ApiKeyProviderGate } from "./api-key-provider-gate.js";
import { sharedQuotaView } from "./api-key-shared-diagnostics.js";
import { assertSharedWindow } from "./api-key-shared-quota-admission.js";
import { compactSharedQuota } from "./api-key-shared-quota-compaction.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import { type RoutingWindow, type RoutingTokens } from "@lcode/shared";
import {
  RoutingError,
  type SharedQuotaFeedback,
  routingDemand,
  type SharedQuotaCoordinator,
  type SharedQuotaInput,
  type SharedQuotaHandle,
} from "@lcode/provider";
import {
  emptySharedQuotaState,
  expireUnsent,
  mergeSharedWindows,
  resourceKey,
  sharedHeld,
  sharedInputSchema,
  sharedWindowsSchema,
  parseSharedQuotaState,
  sharedFeedbackSchema,
  sharedRecovery,
  type SharedQuotaState,
} from "./api-key-shared-quota-state.js";

const MAX_ISSUED_AT_SKEW_MS = 5000;
const DEFAULT_CAPACITY = 4096,
  RESERVATION_TTL_MS = 30_000,
  MAX_FILE_BYTES = 8 * 1024 * 1024;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Options {
  now?: () => number;
  maxLeases?: number;
  clientId?: string;
  lockMaxWaitMs?: number;
}
/** 文件锁是唯一提交点；HTTP 不持锁，进程退出也不重建共享余额。 */
export class FileSharedQuotaCoordinator implements SharedQuotaCoordinator {
  private readonly root: string;
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly clientId: string;
  private readonly providerGate: ApiKeyProviderGate;
  constructor(
    directory: string,
    private readonly options: Options = {},
  ) {
    this.root = resolve(directory);
    this.now = options.now ?? Date.now;
    this.capacity = options.maxLeases ?? DEFAULT_CAPACITY;
    this.clientId = options.clientId ?? randomUUID();
    this.providerGate = new ApiKeyProviderGate(
      this.root,
      this.clientId,
      this.now,
      options.lockMaxWaitMs,
    );
  }
  private async transaction<T>(
    poolKey: string,
    operation: (state: SharedQuotaState) => T,
    write = true,
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/u.test(poolKey)) throw new RoutingError("owner-stale");
    const path = join(this.root, `${poolKey}.json`);
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      return await withFileLock(
        path,
        async () => {
          let state: SharedQuotaState;
          try {
            const raw = await readFile(path, "utf8");
            if (Buffer.byteLength(raw) > MAX_FILE_BYTES)
              throw new Error("Quota file exceeds capacity");
            state = parseSharedQuotaState(JSON.parse(raw));
          } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
            state = emptySharedQuotaState();
          }
          expireUnsent(state, this.now());
          compactSharedQuota(state, this.now());
          sharedRecovery(state).compact();
          const result = operation(state);
          if (write) {
            const encoded = JSON.stringify(state);
            if (Buffer.byteLength(encoded) > MAX_FILE_BYTES)
              throw new RoutingError("quota-owner-capacity");
            await atomicWritePrivateTextFile(path, encoded);
          }
          return result;
        },
        { lockMaxWaitMs: this.options.lockMaxWaitMs },
      );
    } catch (error) {
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("quota-owner-unavailable", { cause: error });
    }
  }
  reserve(input: SharedQuotaInput): Promise<SharedQuotaHandle> {
    const parsed = sharedInputSchema.parse(input);
    if (parsed.request.createdAt + RESERVATION_TTL_MS <= this.now())
      return Promise.reject(new RoutingError("attempt-expired"));
    if (parsed.request.createdAt > this.now() + MAX_ISSUED_AT_SKEW_MS)
      return Promise.reject(new RoutingError("invalid-work-estimate"));
    const poolKey = hash([parsed.providerId, parsed.poolId]);
    const leaseId = hash([parsed.request.scopeKey, parsed.request.attemptId]);
    const keyIdentity = hash(parsed.keyId);
    const fingerprint = hash([
      parsed.keyId,
      parsed.request.modelKey,
      parsed.request.createdAt,
      parsed.request.tokens,
      parsed.request.demands,
      parsed.reserveRules,
      parsed.maxInFlight,
      parsed.windows.map(resourceKey),
    ]);
    return this.providerGate
      .reserve(parsed, () =>
        this.transaction(poolKey, (state) => {
          const existing = state.leases[leaseId];
          if (existing) {
            if (existing.clientId !== this.clientId || existing.fingerprint !== fingerprint)
              throw new RoutingError("attempt-conflict");
            if (existing.state === "expired") throw new RoutingError("attempt-expired");
            return {
              poolKey,
              leaseId,
              fence: existing.fence,
              sequence: existing.sequence,
              expiresAt: existing.expiresAt,
            };
          }
          if (Object.keys(state.leases).length >= this.capacity)
            throw new RoutingError("quota-owner-capacity");
          mergeSharedWindows(state, parsed.windows);
          if (Object.keys(state.resources).length > DEFAULT_CAPACITY)
            throw new RoutingError("quota-owner-capacity");
          const active = Object.values(state.leases).filter(
            (l) => l.keyId === keyIdentity && (l.state === "reserved" || l.state === "dispatched"),
          );
          if (active.length >= parsed.maxInFlight) throw new RoutingError("concurrency-full");
          const demands: Record<string, number> = {};
          // 完整约束由文件 owner 提供；新进程的空快照不能漏掉已确认长窗。
          for (const window of Object.values(state.current).map(
            (key) => state.resources[key]!.window,
          )) {
            if (window.kind === "informational") continue;
            const key = resourceKey(window),
              current = state.resources[key]!.window;
            const held = sharedHeld(state, key);
            const tokens = parsed.request.tokens;
            const demand = routingDemand(
              parsed.request.demands,
              window.resourceId,
              window.unit,
              tokens,
            );
            assertSharedWindow({
              window: current,
              demand,
              held,
              now: this.now(),
              quality: tokens?.quality,
              rules: parsed.reserveRules,
              probe: claimSharedProbe(
                state,
                current,
                leaseId,
                this.now(),
                demand === undefined ||
                  (Boolean(window.unit?.includes("tokens")) && tokens?.quality !== "bound"),
              ),
            });
            if (demand !== undefined) demands[key] = demand;
            else if (sharedNeedsProbe(current, this.now()) && current.remaining !== undefined)
              demands[key] = current.remaining;
          }
          if (
            parsed.reserveRules?.some(
              (rule) =>
                rule.mode === "hard" &&
                !Object.values(state.current).some(
                  (key) => state.resources[key]!.window.resourceId === rule.resourceId,
                ),
            )
          )
            throw new RoutingError("reserve-unverifiable");
          const recoveryPermit = sharedRecovery(state).reserve(
            ["pool", `key:${keyIdentity}`, `model:${hash([keyIdentity, parsed.request.modelKey])}`],
            leaseId,
            this.now(),
          );
          if (Object.keys(state.recovery).length > DEFAULT_CAPACITY)
            throw new RoutingError("quota-owner-capacity");
          const sequence = ++state.sequence,
            fence = randomUUID(),
            expiresAt = parsed.request.createdAt + RESERVATION_TTL_MS;
          state.leases[leaseId] = {
            recoveryPermit,
            clientId: this.clientId,
            fingerprint,
            fence,
            sequence,
            expiresAt,
            keyId: keyIdentity,
            state: "reserved",
            demands,
            actual: {},
            rules: parsed.reserveRules,
            tokens: parsed.request.tokens,
            requested: parsed.request.demands,
            watched: Object.values(state.current),
          };
          return { poolKey, leaseId, fence, sequence, expiresAt };
        }),
      )
      .then(({ result, handle }) => ({ ...result, provider: handle }));
  }
  private mutate<T>(
    handle: SharedQuotaHandle,
    change: (lease: SharedQuotaState["leases"][string], state: SharedQuotaState) => T,
  ) {
    return this.transaction(handle.poolKey, (state) => {
      const lease = state.leases[handle.leaseId];
      if (
        !lease ||
        lease.fence !== handle.fence ||
        lease.sequence !== handle.sequence ||
        lease.clientId !== this.clientId
      )
        throw new RoutingError("owner-stale");
      return change(lease, state);
    });
  }
  dispatch(handle: SharedQuotaHandle): Promise<boolean> {
    // provider 许可是同一次预留的必要部分；缺失时不能退回绕过 gate 的旧派发路径。
    if (!handle.provider)
      return Promise.reject(
        new RoutingError("owner-stale", { scope: "provider", phase: "dispatch" }),
      );
    if (handle.expiresAt <= this.now()) return Promise.reject(new RoutingError("attempt-expired"));
    return this.providerGate.changePool(handle, "dispatch", () =>
      this.mutate(handle, (lease, state) => {
        if (lease.state === "expired") throw new RoutingError("attempt-expired");
        if (lease.state !== "reserved") return false;
        for (const key of lease.watched ?? Object.keys(lease.demands)) {
          const window = state.resources[key]!.window;
          assertSharedWindow({
            window,
            demand: routingDemand(lease.requested, window.resourceId, window.unit, lease.tokens),
            held: sharedHeld(state, key),
            own: lease.demands[key],
            now: this.now(),
            quality: lease.tokens?.quality,
            rules: lease.rules,
            probe:
              state.quotaProbes?.[window.resourceId]?.leaseId === handle.leaseId &&
              (sharedNeedsProbe(window, this.now()) ||
                routingDemand(lease.requested, window.resourceId, window.unit, lease.tokens) ===
                  undefined ||
                lease.tokens?.quality === "estimated"),
          });
        }
        if (lease.recoveryPermit) sharedRecovery(state).dispatch(lease.recoveryPermit, this.now());
        for (const probe of Object.values(state.quotaProbes ?? {}))
          if (probe.leaseId === handle.leaseId) probe.dispatched = true;
        lease.state = "dispatched";
        return true;
      }),
    );
  }
  cancel(handle: SharedQuotaHandle): Promise<void> {
    if (handle.expiresAt <= this.now()) return Promise.resolve();
    return this.providerGate.changePool(handle, "cancel", () =>
      this.mutate(handle, (lease, state) => {
        if (lease.state === "reserved") {
          lease.state = "cancelled";
          cancelSharedProbes(state, handle.leaseId);
          if (lease.recoveryPermit) sharedRecovery(state).cancel(lease.recoveryPermit);
        }
      }),
    );
  }
  finish(handle: SharedQuotaHandle): Promise<void> {
    return this.providerGate.changePool(handle, "finish", () =>
      this.mutate(handle, (lease, state) => {
        if (lease.state === "dispatched") {
          lease.state = "ended";
          if (lease.recoveryPermit)
            sharedRecovery(state).finish(lease.recoveryPermit, "unknown", this.now());
        }
      }),
    );
  }
  rollbackDispatch(handle: SharedQuotaHandle): Promise<void> {
    return this.providerGate.changePool(handle, "rollback", () =>
      this.mutate(handle, (lease, state) => {
        if (lease.state !== "dispatched") return;
        if (lease.recoveryPermit) sharedRecovery(state).rollbackUnsent(lease.recoveryPermit);
        for (const key of Object.keys(lease.demands)) lease.actual[key] = 0;
        lease.notSent = true;
        for (const probe of Object.values(state.quotaProbes ?? {}))
          if (probe.leaseId === handle.leaseId) probe.dispatched = false;
        cancelSharedProbes(state, handle.leaseId);
        lease.state = "ended";
      }),
    );
  }
  usage(
    handle: SharedQuotaHandle,
    actual: Readonly<Record<string, number>>,
    tokens?: RoutingTokens,
    feedback?: SharedQuotaFeedback,
  ): Promise<void> {
    const parsedFeedback = sharedFeedbackSchema.safeParse(feedback ?? {});
    if (!parsedFeedback.success) return Promise.reject(new RoutingError("invalid-usage"));
    // SDK 的部分反馈会显式携带 undefined；缺失量须保持未知，不能当非法值或零消费。
    if (
      Object.values(actual).some((n) => !Number.isFinite(n) || n < 0) ||
      Object.values(tokens ?? {}).some((n) => n !== undefined && (!Number.isFinite(n) || n < 0))
    )
      return Promise.reject(new RoutingError("invalid-usage"));
    return this.providerGate.changePool(
      handle,
      "usage",
      () =>
        this.mutate(handle, (lease, state) => {
          applySharedRecoveryFeedback(state, lease, parsedFeedback.data, this.now());
          if (
            Object.values(tokens ?? {}).some((value) => value !== undefined) ||
            Object.keys(actual).length
          )
            lease.feedbackComplete = true;
          if (tokens) {
            const accepted = (lease.actualTokens ??= {});
            for (const field of ["input", "output", "total"] as const)
              if (tokens[field] !== undefined && !Object.hasOwn(accepted, field))
                accepted[field] = tokens[field];
          }
          for (const key of new Set([...Object.keys(lease.demands), ...(lease.watched ?? [])])) {
            const window = state.resources[key]!.window;
            const value = Object.hasOwn(actual, window.resourceId)
              ? actual[window.resourceId]
              : routingDemand(undefined, window.resourceId, window.unit, lease.actualTokens);
            if (value !== undefined && !Object.hasOwn(lease.actual, key)) lease.actual[key] = value;
          }
        }),
      parsedFeedback.data,
    );
  }
  observe(
    providerId: string,
    poolId: string,
    windows: readonly RoutingWindow[],
    coversThroughSeq?: number,
  ): Promise<void> {
    sharedInputSchema.shape.providerId.parse(providerId);
    sharedInputSchema.shape.poolId.parse(poolId);
    const parsed = sharedWindowsSchema.parse(windows);
    return this.transaction(hash([providerId, poolId]), (state) =>
      mergeSharedWindows(state, parsed, coversThroughSeq),
    );
  }
  async inspect(providerId: string, poolId: string) {
    const provider = await this.providerGate.inspect(providerId);
    const view = await this.transaction(
      hash([providerId, poolId]),
      (state) => sharedQuotaView(state, this.capacity, this.now()),
      false,
    );
    const count = provider.recoveryCount + (view.recoveryCount ?? view.recovery.length);
    return {
      ...view,
      provider,
      recoveryCount: count,
      recoveryTruncated: count > 100,
      recovery: [...provider.recovery, ...view.recovery].slice(0, 100),
    };
  }
}
