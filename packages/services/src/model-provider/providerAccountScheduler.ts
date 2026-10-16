import {
  RoutingScheduler,
  RoutingRecovery,
  RoutingError,
  readRoutingCacheFacts,
  type RoutingCacheFacts,
  readRateLimitHint,
  readRateLimitScope,
  type RoutingCandidate,
  type RoutingWindow,
  type ProviderRoutingPolicy,
} from "@lcode/provider";
import { routingInvocationSchema, type RoutingInvocation, type RoutingUsage } from "@lcode/shared";
import type { AuthModel } from "@lcode/provider-node";
import { ProviderRoutingFeedback } from "./providerRoutingFeedback.js";
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

/** 唯一 ProviderAccounts 的调度状态；额度只读原 cache，既不发 quota 请求也不写额度事实。 */
export class ProviderAccountScheduler {
  private readonly schedulers = new Map<string, { signature: string; owner: RoutingScheduler }>();
  private readonly blocked = new Map<
    string,
    { generation: number; credentialGeneration?: number; until: number }
  >();
  private readonly recovery = new RoutingRecovery();
  private readonly cacheFacts = new Map<string, RoutingCacheFacts>();
  private readonly now: () => number;
  private readonly feedback: ProviderRoutingFeedback;
  constructor(
    readonly readPolicy: (channelId: string) => Promise<ProviderRoutingPolicy | null | undefined>,
    private readonly quotas: Pick<ProviderAccountQuotas, "peek">,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.feedback = new ProviderRoutingFeedback(this.now);
  }

  async requireCapability(_channel: string, invocation?: RoutingInvocation): Promise<boolean> {
    if (!invocation) throw new RoutingError("routing-capability-required");
    routingInvocationSchema.parse(invocation);
    return true;
  }

  async reserve<T extends Account>(
    channel: string,
    routes: readonly Route<T>[],
    request: Request,
    invocation?: RoutingInvocation,
  ) {
    const stored = await this.readPolicy(channel);
    const policy: ProviderRoutingPolicy = {
      version: 1,
      strategy: stored?.strategy ?? "reliable-first",
    };
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
    const providerRecoveryKey = JSON.stringify(["provider", channel]);
    if (routes.length && !this.recovery.available([providerRecoveryKey], now))
      throw new RoutingError("route-cooling", {
        scope: "provider",
        phase: "admission",
        dispatch: "unsent",
        retryAt: this.recovery.retryAt([providerRecoveryKey]),
      });
    const recoveryKeys = new Map<
      string,
      { all: string[]; account: string; provider: string; model: string; shared: string[] }
    >();
    const cacheKey = (id: string) =>
      JSON.stringify([
        channel,
        id,
        routes.find((r) => r.account.connectionId === id)?.account.routingEpoch ?? 0,
        routes[0]?.model.protocol,
        routes[0]?.model.id,
      ]);
    const candidates: RoutingCandidate[] = routes.map(({ account, model }) => {
      const storedCache = this.cacheFacts.get(cacheKey(account.connectionId));
      const cache = storedCache && storedCache.validUntil > now ? storedCache : undefined;
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
      const accountKey = JSON.stringify([
        "account",
        channel,
        account.connectionId,
        account.routingEpoch ?? 0,
      ]);
      const all = [providerKey, accountKey, modelKey, ...shared];
      recoveryKeys.set(account.connectionId, {
        all,
        account: accountKey,
        provider: providerKey,
        model: modelKey,
        shared: shared.length ? shared : [providerKey],
      });
      return {
        id: account.connectionId,
        generation: String(account.routingEpoch ?? 0),
        windows,
        availableAt: this.recovery.retryAt(all),
        portability: model.routingPortability ?? cache?.portability ?? "unknown",
        cacheGroupId: cache?.groupId,
        cacheSwitchCost: cache?.switchCost,
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
      context.compatibilityKey ?? null,
    ]);
    const input = {
      attemptId: context.attemptId,
      createdAt: context.createdAt,
      scopeKey,
      turnId: context.turnId,
      modelKey: JSON.stringify([routes[0]?.model.protocol, routes[0]?.model.id, "completion"]),
      workUnits: context.tokens?.total ?? WORK_QUANTUM,
      tokens: context.tokens,
      demands,
      signal: request.signal,
    };
    const plan = entry.owner.plan(candidates, input);
    const original = entry.owner.reserve(candidates, input, plan.revision);
    const resources = recoveryKeys.get(original.routeId)!;
    const affected = (scope: string | undefined, status: number) =>
      scope === "key"
        ? [resources.account]
        : scope === "model"
          ? [resources.model]
          : scope === "shared" || scope === "pool"
            ? resources.shared
            : scope === "provider" || status === 429
              ? [resources.provider]
              : [resources.model];
    const permit = this.recovery.reserve(
      resources.all,
      JSON.stringify([channel, original.sequence]),
      now,
    );
    let feedbackHandle: ReturnType<ProviderRoutingFeedback["retain"]> | undefined;
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
        feedbackHandle?.cancel();
      },
      finish: (result: Parameters<typeof original.finish>[0]) => {
        original.finish(result);
        this.recovery.finish(permit, result.outcome ?? "unknown", this.now());
        feedbackHandle?.finish();
      },
      observeUsage: (result: Parameters<typeof original.observeUsage>[0]) => {
        original.observeUsage(result);
        this.recovery.observe(permit, result.outcome, this.now());
      },
    };
    const selected = candidates.find((candidate) => candidate.id === lease.routeId)!;
    try {
      feedbackHandle = this.feedback.retain(JSON.stringify(context), (usage) => {
        const actualDemands: Record<string, number> = {};
        for (const window of selected.windows) {
          if (window.unit === "tokens" && usage.workUnits !== undefined)
            actualDemands[window.resourceId] = usage.workUnits;
          if (window.unit === "input_tokens" && usage.inputTokens !== undefined)
            actualDemands[window.resourceId] = usage.inputTokens;
          if (window.unit === "output_tokens" && usage.outputTokens !== undefined)
            actualDemands[window.resourceId] = usage.outputTokens;
        }
        if (usage.statusCode === 429 || (usage.statusCode !== undefined && usage.statusCode >= 500))
          this.recovery.fail(
            permit,
            affected(usage.rateLimitScope, usage.statusCode),
            this.now() + (usage.retryAfterMs ?? 1000),
          );
        lease.observeUsage({
          outcome: usage.outcome,
          statusCode: usage.statusCode,
          replaySafeFailure: usage.replaySafeFailure,
          workUnits: usage.workUnits,
          ...(Object.keys(actualDemands).length ? { actualDemands } : {}),
        });
      });
    } catch (error) {
      lease.cancel();
      throw error;
    }
    return {
      lease,
      plan,
      observeHeaders: (response: Response) => {
        const cache = readRoutingCacheFacts(response.headers, this.now());
        if (cache) this.cacheFacts.set(cacheKey(lease.routeId), cache);
      },
      validate: async () => {
        if (
          JSON.stringify({
            version: 1,
            strategy: (await this.readPolicy(channel))?.strategy ?? "reliable-first",
          }) !== signature
        ) {
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
            affected(readRateLimitScope(response.headers), response.status),
            this.now() + readRateLimitHint(response.headers).delayMs,
          );
        // 已进入物理调用后无响应的失败仍需冷却；保留未知消费，不能靠下一请求直接重试失效连接。
        if (!response && !request.signal.aborted)
          this.recovery.fail(permit, [resources.model], this.now() + 1000);
        lease.finish({
          statusCode: response?.status,
          outcome: request.signal.aborted ? "cancelled" : success ? "unknown" : "failed",
          replaySafeFailure: Boolean(response && !response.ok),
          ...(success
            ? {
                cacheUntil:
                  this.cacheFacts.get(cacheKey(lease.routeId))?.validUntil ??
                  (routes.find((route) => route.account.connectionId === account.connectionId)
                    ?.model.routingCacheTtlMs
                    ? this.now() +
                      routes.find((route) => route.account.connectionId === account.connectionId)!
                        .model.routingCacheTtlMs!
                    : 0),
              }
            : {}),
        });
      },
    };
  }

  observeUsage(invocation: RoutingInvocation, usage: RoutingUsage): void {
    this.feedback.observe(JSON.stringify(routingInvocationSchema.parse(invocation)), usage);
  }

  readDiagnostics(channel: string) {
    const owner = this.schedulers.get(channel)?.owner;
    if (!owner) return null;
    const filter = (id: string) => {
      try {
        const resource = JSON.parse(id);
        return (
          resource[0] === channel ||
          ((resource[0] === "provider" || resource[0] === "account") && resource[1] === channel) ||
          (resource[0] === "pool" && JSON.parse(resource[1])[0] === channel)
        );
      } catch {
        return false;
      }
    };
    return {
      asOf: this.now(),
      owner: owner.readDiagnostics(),
      feedback: this.feedback.inspect(),
      recovery: this.recovery.inspect(this.now(), 0, 100, filter),
      recoveryCount: this.recovery.count(filter),
      recoveryTruncated: this.recovery.count(filter) > 100,
    };
  }

  dispose(): void {
    for (const entry of this.schedulers.values()) entry.owner.dispose();
    this.schedulers.clear();
    this.blocked.clear();
    this.recovery.clear();
    this.cacheFacts.clear();
    this.feedback.clear();
  }
}
