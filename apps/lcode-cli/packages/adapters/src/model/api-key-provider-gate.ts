import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import {
  RoutingError,
  RoutingRecovery,
  type SharedQuotaHandle,
  type SharedQuotaInput,
  type SharedQuotaFeedback,
} from "@lcode/provider";
import { sharedQuotaStateSchema } from "./api-key-shared-quota-state.js";
const CAPACITY = 4096,
  MAX_FILE_BYTES = 8 * 1024 * 1024,
  RESERVATION_TTL_MS = 30000,
  FAILURE_BACKOFF_MS = 1000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const providerGateLeaseId = (poolKey: string, leaseId: string) => hash([poolKey, leaseId]);
const leaseSchema = sharedQuotaStateSchema.shape.leases.valueType.pick({
  recoveryPermit: true,
  expiresAt: true,
  clientId: true,
  fingerprint: true,
  fence: true,
  sequence: true,
  state: true,
});
const schema = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  recovery: sharedQuotaStateSchema.shape.recovery,
  leases: z.record(z.string(), leaseSchema),
});
type State = z.infer<typeof schema>;
/** 每供应商一个恢复 gate。固定先 provider 锁再 pool 锁；不保存或复制任何额度。 */
export class ApiKeyProviderGate {
  constructor(
    private readonly root: string,
    private readonly clientId: string,
    private readonly now: () => number,
    private readonly lockMaxWaitMs?: number,
  ) {}
  private async transaction<T>(
    key: string,
    operation: (state: State, recovery: RoutingRecovery) => Promise<T>,
    write = true,
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new RoutingError("owner-stale");
    const path = join(this.root, key + ".provider.json");
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      return await withFileLock(
        path,
        async () => {
          let state: State;
          try {
            const raw = await readFile(path, "utf8");
            if (Buffer.byteLength(raw) > MAX_FILE_BYTES)
              throw new RoutingError("quota-owner-capacity");
            state = schema.parse(JSON.parse(raw));
          } catch (e) {
            if ((e as { code?: string }).code !== "ENOENT") throw e;
            state = { version: 1, sequence: 0, recovery: {}, leases: {} };
          }
          const recovery = new RoutingRecovery(
            state.recovery,
            Object.values(state.leases).flatMap((l) =>
              l.recoveryPermit ? [l.recoveryPermit] : [],
            ),
          );
          if (write)
            for (const [id, lease] of Object.entries(state.leases))
              if (lease.expiresAt <= this.now() && lease.state !== "dispatched") {
                if (lease.state === "reserved" && lease.recoveryPermit)
                  recovery.cancel(lease.recoveryPermit);
                if (lease.state !== "ended" || lease.recoveryPermit?.closed)
                  delete state.leases[id];
              }
          if (write)
            recovery.compact(
              Object.values(state.leases).flatMap((l) =>
                l.recoveryPermit ? [l.recoveryPermit] : [],
              ),
            );
          let result: T | undefined,
            failure: unknown,
            failed = false;
          try {
            result = await operation(state, recovery);
          } catch (error) {
            failed = true;
            failure = error;
          }
          const encoded = JSON.stringify(state);
          if (Buffer.byteLength(encoded) > MAX_FILE_BYTES)
            throw new RoutingError("quota-owner-capacity");
          if (write) await atomicWritePrivateTextFile(path, encoded);
          if (failed) throw failure;
          return result as T;
        },
        { lockMaxWaitMs: this.lockMaxWaitMs },
      );
    } catch (e) {
      if (e instanceof RoutingError) {
        if (e.code === "route-cooling")
          throw new RoutingError(e.code, { ...e.details, scope: "provider" });
        throw e;
      }
      throw new RoutingError("quota-owner-unavailable", {
        scope: "provider",
        phase: "storage",
        cause: e,
      });
    }
  }
  async reserve<T>(
    input: SharedQuotaInput,
    operation: () => Promise<T>,
  ): Promise<{ result: T; handle: SharedQuotaHandle }> {
    const poolKey = hash(["provider", input.providerId]),
      leaseId = providerGateLeaseId(
        hash([input.providerId, input.poolId]),
        hash([input.request.scopeKey, input.request.attemptId]),
      );
    return this.transaction(poolKey, async (state, recovery) => {
      let lease = state.leases[leaseId];
      const fingerprint = hash([input.poolId, input.keyId, input.request]);
      if (lease) {
        if (lease.clientId !== this.clientId || lease.fingerprint !== fingerprint)
          throw new RoutingError("attempt-conflict");
        if (lease.state !== "reserved") throw new RoutingError("attempt-expired");
      } else {
        if (Object.keys(state.leases).length >= CAPACITY)
          throw new RoutingError("quota-owner-capacity", { scope: "provider" });
        const permit = recovery.reserve(["provider"], leaseId, this.now());
        lease = state.leases[leaseId] = {
          recoveryPermit: permit,
          clientId: this.clientId,
          fingerprint,
          fence: randomUUID(),
          sequence: ++state.sequence,
          expiresAt: input.request.createdAt + RESERVATION_TTL_MS,
          state: "reserved",
        };
      }
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        recovery.cancel(lease.recoveryPermit!);
        lease.state = "cancelled";
        throw error;
      }
      return {
        result,
        handle: {
          poolKey,
          leaseId,
          fence: lease.fence,
          sequence: lease.sequence,
          expiresAt: lease.expiresAt,
        },
      };
    });
  }
  changePool<T>(
    handle: SharedQuotaHandle,
    kind: Parameters<ApiKeyProviderGate["change"]>[1],
    change: () => Promise<T>,
    feedback?: SharedQuotaFeedback,
  ): Promise<T> {
    // 两个各自合法的句柄也不能拼接；gate 必须授权当前 pool 预留。
    if (
      handle.provider &&
      providerGateLeaseId(handle.poolKey, handle.leaseId) !== handle.provider.leaseId
    )
      return Promise.reject(
        new RoutingError("owner-stale", {
          scope: "provider",
          phase: kind === "dispatch" ? "dispatch" : "feedback",
        }),
      );
    return this.change(handle.provider, kind, change, feedback);
  }
  async change<T>(
    handle: SharedQuotaHandle | undefined,
    kind: "dispatch" | "cancel" | "finish" | "usage" | "rollback",
    operation: () => Promise<T>,
    feedback?: SharedQuotaFeedback,
  ): Promise<T> {
    if (!handle) return operation();
    return this.transaction(handle.poolKey, async (state, recovery) => {
      const lease = state.leases[handle.leaseId];
      if (
        !lease ||
        lease.fence !== handle.fence ||
        lease.sequence !== handle.sequence ||
        lease.clientId !== this.clientId
      )
        throw new RoutingError("owner-stale");
      const permit = lease.recoveryPermit!;
      if (kind === "dispatch") {
        if (lease.expiresAt <= this.now()) throw new RoutingError("attempt-expired");
        if (lease.state === "reserved") {
          recovery.dispatch(permit, this.now());
          lease.state = "dispatched";
        }
      }
      if (kind === "cancel" && lease.state === "reserved") {
        recovery.cancel(permit);
        lease.state = "cancelled";
      }
      if (kind === "rollback" && lease.state === "dispatched") {
        recovery.rollbackUnsent(permit);
        lease.state = "ended";
      }
      if (kind === "finish" && lease.state === "dispatched") {
        lease.state = "ended";
        recovery.finish(permit, "unknown", this.now());
      }
      if (kind === "usage" && feedback) {
        const scope = feedback.rateLimitScope;
        const providerFailure =
          scope === "provider" || (feedback.statusCode === 429 && scope === undefined);
        if (providerFailure && feedback.statusCode !== undefined && feedback.statusCode >= 400)
          recovery.fail(
            permit,
            ["provider"],
            this.now() + (feedback.retryAfterMs ?? FAILURE_BACKOFF_MS),
          );
        recovery.observe(permit, feedback.outcome, this.now());
      }
      try {
        return await operation();
      } catch (error) {
        // 下游文件失败不能回滚已经接收的 provider 冷却；明确未派发拒绝才回收 gate 许可。
        if (
          kind === "dispatch" &&
          error instanceof RoutingError &&
          error.code !== "quota-owner-unavailable" &&
          error.code !== "dispatch-uncertain"
        ) {
          recovery.rollbackUnsent(permit);
          lease.state = "cancelled";
        }
        throw error;
      }
    });
  }
  inspect(providerId: string) {
    return this.transaction(
      hash(["provider", providerId]),
      async (state, recovery) => ({
        retainedAttempts: Object.keys(state.leases).length,
        recovery: recovery.inspect(this.now()),
        recoveryCount: recovery.count(),
      }),
      false,
    );
  }
}
