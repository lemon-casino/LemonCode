import {
  RoutingScheduler,
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
  private readonly sharedCooldowns = new Map<string, number>();
  private readonly feedback = new Map<
    string,
    { expires: number; observe: (usage: RoutingUsage) => void }
  >();
  constructor(
    readonly readPolicy: (channelId: string) => Promise<ProviderRoutingPolicy | null | undefined>,
    private readonly quotas: Pick<ProviderAccountQuotas, "peek">,
  ) {}

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
      entry = { signature, owner: new RoutingScheduler(policy) };
      this.schedulers.set(channel, entry);
    } else if (entry.signature !== signature) {
      entry.owner.setPolicy(policy);
      entry.signature = signature;
    }
    const now = Date.now(),
      demands: Record<string, number> = {};
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
      return {
        id: account.connectionId,
        generation: String(account.routingEpoch ?? 0),
        windows,
        portability: model.routingPortability ?? "unknown",
        ...((this.sharedCooldowns.get(channel) ?? 0) > now || blocked
          ? { unavailable: "route-cooling" }
          : {}),
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
      workUnits: WORK_QUANTUM,
      demands,
      signal: request.signal,
    };
    const plan = entry.owner.plan(candidates, input);
    const lease = entry.owner.reserve(candidates, input, plan.revision);
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
          replaySafeFailure: usage.replaySafeFailure,
          workUnits: usage.workUnits,
          ...(Object.keys(actualDemands).length ? { actualDemands } : {}),
        });
        if (usage.statusCode === 429) {
          const until = Date.now() + (usage.retryAfterMs ?? 0);
          if (usage.rateLimitScope === "shared")
            this.sharedCooldowns.set(
              channel,
              Math.max(this.sharedCooldowns.get(channel) ?? 0, until),
            );
          else
            this.blocked.set(
              JSON.stringify([selected.id, routes[0]?.model.protocol, routes[0]?.model.id]),
              { generation: Number(selected.generation), until },
            );
        }
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
        if (response?.status === 429) {
          const model = routes.find(
            (route) => route.account.connectionId === account.connectionId,
          )!.model;
          const until = Date.now() + readRateLimitHint(response.headers).delayMs;
          // 只把明确共享的冷却扩大到整个渠道；模型拒绝不能撤销其它模型资格。
          if (response.headers.get("x-lcode-rate-limit-scope") === "shared")
            this.sharedCooldowns.set(
              channel,
              Math.max(this.sharedCooldowns.get(channel) ?? 0, until),
            );
          else
            this.blocked.set(JSON.stringify([account.connectionId, model.protocol, model.id]), {
              generation: account.routingEpoch ?? 0,
              until,
            });
        }
        lease.finish({
          outcome: request.signal.aborted ? "cancelled" : success ? "unknown" : "failed",
          replaySafeFailure: Boolean(response && !response.ok),
          ...(success &&
          routes.find((route) => route.account.connectionId === account.connectionId)?.model
            .routingCacheTtlMs
            ? {
                cacheUntil:
                  Date.now() +
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

  dispose(): void {
    for (const entry of this.schedulers.values()) entry.owner.dispose();
    this.schedulers.clear();
    this.blocked.clear();
    this.sharedCooldowns.clear();
    this.feedback.clear();
  }
}
