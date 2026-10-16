import {
  RoutingScheduler,
  RoutingRecovery,
  RoutingError,
  readRateLimitHint,
  type RoutingCandidate,
  type RoutingWindow,
  type ProviderRoutingPolicy,
} from "@lcode/provider";
import { routingInvocationSchema, type RoutingInvocation, type RoutingUsage } from "@lcode/shared";
import type { AuthModel } from "@lcode/provider-node";
import type { ProviderAccountQuotas } from "./providerAccountQuotas.js";

interface Account {
  connectionId: string;
  generation: number;
  routingEpoch?: number;
  channelId: string;
}
interface Route<T extends Account> {
  account: T;
  model: AuthModel;
}
const WORK_QUANTUM = 4096;
const CACHE_TTL = 5 * 60_000;

/** 唯一 ProviderAccounts 的调度状态；额度只读原 cache，既不发 quota 请求也不写额度事实。 */
export class ProviderAccountScheduler {
  private readonly schedulers = new Map<string, { signature: string; owner: RoutingScheduler }>();
  private readonly blocked = new Map<
    string,
    { generation: number; credentialGeneration?: number; until: number }
  >();
  private readonly recovery = new RoutingRecovery();
  private readonly now: () => number;
  private readonly feedback = new Map<
    string,
    { expires: number; observe: (usage: RoutingUsage) => void }
  >();
  constructor(
    readonly readPolicy: (channelId: string) => Promise<ProviderRoutingPolicy | null | undefined>,
    private readonly quotas: Pick<ProviderAccountQuotas, "peek">,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async requireCapability(channel: string, invocation?: RoutingInvocation): Promise<boolean> {
    const enabled = Boolean(await this.readPolicy(channel));
    if (enabled) {
      if (!invocation) throw new RoutingError("routing-capability-required");
      routingInvocationSchema.parse(invocation);
    }
    return enabled;
  }

  async reserve<T extends Account>(
    channel: string,
    routes: readonly Route<T>[],
    request: Request,
    invocation?: RoutingInvocation,
  ) {
    const policy = await this.readPolicy(channel);
    if (!policy) return undefined;
    if (!invocation) throw new RoutingError("routing-capability-required");
    const context = routingInvocationSchema.parse(invocation);
    const signature = JSON.stringify(policy);
    let entry = this.schedulers.get(channel);
    if (!entry) {
      entry = { signature, owner: new RoutingScheduler(policy, { now: this.now }) };
      this.schedulers.set(channel, entry);
    } else if (entry.signature !== signature) {
      entry.owner.setPolicy(policy);
      entry.signature = signature;
    }
    const now = this.now(),
      demands: Record<string, number> = {};
    const recoveryKeys = new Map<string, { all: string[]; model: string; shared: string[] }>();
    const candidates: RoutingCandidate[] = routes.map(({ account, model }) => {
      const cached = this.quotas.peek(
        account.connectionId,
        account.generation,
        account.routingEpoch,
      );
      const windows: RoutingWindow[] = (cached?.value.windows ?? [])
        .filter(
          (window) =>
            (!window.modelId || window.modelId === model.id) &&
            (!window.includedModelIds || window.includedModelIds.includes(model.id)) &&
            !window.excludedModelIds?.includes(model.id) &&
            !(
              channel === "copilot" &&
              (window.id === "completions" ||
                (window.id === "premium_interactions" &&
                  model.billing?.kind === "multiplier" &&
                  model.billing.multiplier === 0 &&
                  (!model.billing.validUntil || Date.parse(model.billing.validUntil) > now)))
            ),
        )
        .map((window) => {
          const sharedPool =
            (window.scope === "organization" || window.scope === "shared") && window.quotaPoolId;
          const resourceId = JSON.stringify([
            channel,
            sharedPool ? window.scope : "account",
            sharedPool || account.connectionId,
            window.id,
            window.unit ?? null,
          ]);
          if (window.unit === "requests") demands[resourceId] = 1;
          const resetAt = window.resetAt ? Date.parse(window.resetAt) : undefined;
          return {
            resourceId,
            shared: Boolean(sharedPool),
            instanceId:
              window.instanceId ??
              (window.resetMode === "fixed" ? window.resetAt : undefined) ??
              "unverified-period",
            stableId: window.stableId ?? !/^window-|^group-|^bucket-/u.test(window.id),
            resetMode: window.resetMode ?? "unknown",
            revision: cached!.revision,
            kind:
              window.unlimited || window.id === "reset-credits"
                ? "informational"
                : (window.kind ?? "unknown"),
            quality:
              cached!.value.stale || (resetAt !== undefined && resetAt <= now)
                ? "stale"
                : cached!.value.partial
                  ? "partial"
                  : "fresh",
            remaining: window.remaining,
            limit: window.limit,
            usedPercent: window.usedPercent,
            unit: window.unit,
            resetAt,
            ...(window.expiresAt ? { expiresAt: Date.parse(window.expiresAt) } : {}),
          };
        });
      // 鉴权故障随原凭据退休；两层阻断都检查，避免失效鉴权项遮住有效的模型冷却。
      const blocked = [
        this.blocked.get(account.connectionId),
        this.blocked.get(JSON.stringify([account.connectionId, model.protocol, model.id])),
      ].some(
        (block) =>
          block &&
          block.generation === (account.routingEpoch ?? 0) &&
          (block.credentialGeneration === undefined ||
            block.credentialGeneration === account.generation) &&
          block.until > now,
      );
      const modelKey = JSON.stringify([
        channel,
        account.connectionId,
        account.routingEpoch ?? 0,
        model.protocol,
        model.id,
      ]);
      const shared = windows
        .filter((window) => window.shared)
        .map((window) => JSON.stringify(["pool", window.resourceId]));
      const providerKey = JSON.stringify(["provider", channel]);
      const all = [providerKey, modelKey, ...shared];
      recoveryKeys.set(account.connectionId, {
        all,
        model: modelKey,
        shared: shared.length ? shared : [providerKey],
      });
      return {
        id: account.connectionId,
        generation: String(account.routingEpoch ?? 0),
        windows,
        portability: model.routingPortability ?? "unknown",
        ...(!this.recovery.available(all, now) || blocked ? { unavailable: "route-cooling" } : {}),
      };
    });
    const scopeKey = JSON.stringify([
      context.workspaceKey,
      context.remoteSessionId ?? null,
      context.sessionId,
      context.executionId ?? null,
      context.actorId ?? null,
      channel,
      routes[0]?.model.protocol,
      routes[0]?.model.id,
    ]);
    const input = {
      attemptId: context.attemptId,
      scopeKey,
      turnId: context.turnId,
      modelKey: JSON.stringify([routes[0]?.model.protocol, routes[0]?.model.id, "completion"]),
      workUnits: WORK_QUANTUM,
      demands,
      signal: request.signal,
    };
    const plan = entry.owner.plan(candidates, input);
    const original = entry.owner.reserve(candidates, input, plan.revision);
    const resources = recoveryKeys.get(original.routeId)!;
    const permit = this.recovery.reserve(
      resources.all,
      JSON.stringify([channel, original.sequence]),
      now,
    );
    const lease = {
      ...original,
      dispatch: () => {
        this.recovery.dispatch(permit, this.now());
        try {
          return original.dispatch();
        } catch (error) {
          this.recovery.rollbackUnsent(permit);
          throw error;
        }
      },
      cancel: () => {
        original.cancel();
        this.recovery.cancel(permit);
      },
      finish: (result: Parameters<typeof original.finish>[0]) => {
        original.finish(result);
        this.recovery.finish(permit, result.outcome ?? "unknown", this.now());
      },
      observeUsage: (result: Parameters<typeof original.observeUsage>[0]) => {
        original.observeUsage(result);
        this.recovery.observe(permit, result.outcome, this.now());
      },
    };
    const selected = candidates.find((candidate) => candidate.id === lease.routeId)!;
    for (const [id, item] of this.feedback) if (item.expires <= now) this.feedback.delete(id);
    this.feedback.set(JSON.stringify(context), {
      expires: now + CACHE_TTL,
      observe: (usage) => {
        const actualDemands: Record<string, number> = {};
        for (const window of selected.windows) {
          if (window.unit === "tokens" && usage.workUnits !== undefined)
            actualDemands[window.resourceId] = usage.workUnits;
          if (window.unit === "input_tokens" && usage.inputTokens !== undefined)
            actualDemands[window.resourceId] = usage.inputTokens;
          if (window.unit === "output_tokens" && usage.outputTokens !== undefined)
            actualDemands[window.resourceId] = usage.outputTokens;
        }
        lease.observeUsage({
          outcome: usage.outcome,
          statusCode: usage.statusCode,
          replaySafeFailure: usage.replaySafeFailure,
          workUnits: usage.workUnits,
          ...(Object.keys(actualDemands).length ? { actualDemands } : {}),
        });
        if (usage.statusCode === 429 || (usage.statusCode !== undefined && usage.statusCode >= 500))
          this.recovery.fail(
            permit,
            usage.statusCode === 429
              ? usage.rateLimitScope === "key"
                ? [resources.model]
                : resources.shared
              : usage.rateLimitScope === "shared"
                ? resources.shared
                : [resources.model],
            this.now() + (usage.retryAfterMs ?? 1000),
          );
      },
    });
    return {
      lease,
      plan,
      validate: async () => {
        if (JSON.stringify(await this.readPolicy(channel)) !== signature) {
          lease.cancel();
          throw new RoutingError("policy-conflict");
        }
      },
      finish: (account: T, response?: Response, success = false) => {
        if (response?.status === 401 || response?.status === 403)
          this.blocked.set(account.connectionId, {
            generation: account.routingEpoch ?? 0,
            credentialGeneration: account.generation,
            until: Infinity,
          });
        if (response && (response.status === 429 || response.status >= 500))
          this.recovery.fail(
            permit,
            response.status === 429
              ? readRateLimitHint(response.headers).scope === "shared"
                ? resources.shared
                : [resources.model]
              : [resources.model],
            this.now() + readRateLimitHint(response.headers).delayMs,
          );
        // 已进入物理调用后无响应的失败仍需冷却；保留未知消费，不能靠下一请求直接重试失效连接。
        if (!response && !request.signal.aborted)
          this.recovery.fail(permit, [resources.model], this.now() + 1000);
        lease.finish({
          statusCode: response?.status,
          outcome: request.signal.aborted ? "cancelled" : success ? "unknown" : "failed",
          replaySafeFailure: Boolean(response && !response.ok),
          ...(success &&
          routes.find((route) => route.account.connectionId === account.connectionId)?.model
            .routingCacheTtlMs
            ? {
                cacheUntil:
                  this.now() +
                  routes.find((route) => route.account.connectionId === account.connectionId)!.model
                    .routingCacheTtlMs!,
              }
            : {}),
        });
      },
    };
  }

  observeUsage(invocation: RoutingInvocation, usage: RoutingUsage): void {
    this.feedback.get(JSON.stringify(routingInvocationSchema.parse(invocation)))?.observe(usage);
  }

  readDiagnostics(channel: string) {
    const owner = this.schedulers.get(channel)?.owner;
    if (!owner) return null;
    return {
      asOf: this.now(),
      owner: owner.readDiagnostics(),
      recovery: this.recovery.inspect(this.now()).filter((item) => {
        try {
          const resource = JSON.parse(item.resource);
          return (
            resource[0] === channel ||
            (resource[0] === "provider" && resource[1] === channel) ||
            (resource[0] === "pool" && JSON.parse(resource[1])[0] === channel)
          );
        } catch {
          return false;
        }
      }),
    };
  }

  dispose(): void {
    for (const entry of this.schedulers.values()) entry.owner.dispose();
    this.schedulers.clear();
    this.blocked.clear();
    this.recovery.clear();
    this.feedback.clear();
  }
}
