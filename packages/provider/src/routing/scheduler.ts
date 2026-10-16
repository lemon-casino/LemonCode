import { RoutingReservationOwner, type RoutingReservation } from "./reservation-owner.js";
import {
  providerRoutingPolicySchema,
  type ProviderRoutingPolicy,
  type RoutingCandidate,
  type RoutingPlan,
  type RoutingRequest,
  type RoutingWindow,
} from "@lcode/shared/provider-routing";
import { planRouting } from "./planner.js";
import { routingWeight, routingConcurrency } from "./values.js";
import { RoutingError } from "./error.js";
import { RoutingDirectory } from "./directory.js";

const QUANTUM = 4096;
export type { RoutingReservation } from "./reservation-owner.js";
/** 同步 mutation 由原执行 owner 调用，类本身无 IO、定时器或业务队列。 */
export class RoutingScheduler extends RoutingReservationOwner {
  private directory?: RoutingDirectory;
  private policy: ProviderRoutingPolicy;

  constructor(policy: ProviderRoutingPolicy, options: { now?: () => number } = {}) {
    super(options.now ?? Date.now);
    this.policy = providerRoutingPolicySchema.parse(policy);
  }

  plan(candidates: readonly RoutingCandidate[], request: RoutingRequest): RoutingPlan {
    return this.decision(candidates, request, this.directory).plan;
  }

  setPolicy(policy: ProviderRoutingPolicy): void {
    this.policy = providerRoutingPolicySchema.parse(policy);
    this.invalidatePending();
    if (this.directory) this.setDirectory(this.directory.sourceIds, this.directory.read);
  }

  invalidatePending(): void {
    this.revision++;
    this.policyEpoch++;
  }

  private decision(
    candidates: readonly RoutingCandidate[],
    request: RoutingRequest,
    directory?: RoutingDirectory,
    now = this.now(),
  ) {
    const credits = new Map(
      candidates.map((candidate) => {
        const quantum = QUANTUM * routingWeight(this.policy, candidate.id);
        return [
          candidate.id,
          (this.credit.get(candidate.id) ?? quantum) +
            (this.round - (this.creditedRound.get(candidate.id) ?? this.round)) * quantum,
        ] as const;
      }),
    );
    const projected = candidates.map((candidate) =>
      this.history.project(
        candidate,
        now,
        (window) => this.ledger.available(window),
        request.modelKey,
      ),
    );
    const calculate = () =>
      planRouting(this.policy, projected, request, {
        orderIndex: directory?.order,
        directorySize: directory?.ids.length,
        revision: this.revision,
        now,
        inFlight: this.inFlight,
        credit: credits,
        cursor: this.cursor,
        selections: this.selections,
        ledger: this.ledger,
        binding: this.bindings.get(request.scopeKey, request.turnId),
      });
    let plan = calculate(),
      round = this.round;
    // routes 只供有界展示；补充轮次必须检查同 tier 的全部合格候选，避免第 33 个 Key 饿死。
    const tier = plan.tiers?.[plan.routes[0] ?? ""];
    const eligible = candidates.filter(
      (candidate) => !plan.excluded[candidate.id] && plan.tiers?.[candidate.id] === tier,
    );
    if (
      plan.effectiveStrategy === "share-rotation" &&
      eligible.length &&
      eligible.every((candidate) => (credits.get(candidate.id) ?? 0) <= 0)
    ) {
      let steps = Infinity;
      for (const candidate of eligible)
        steps = Math.min(
          steps,
          Math.floor(
            -(credits.get(candidate.id) ?? 0) /
              (QUANTUM * routingWeight(this.policy, candidate.id)),
          ) + 1,
        );
      round += steps;
      for (const candidate of candidates)
        credits.set(
          candidate.id,
          credits.get(candidate.id)! + steps * QUANTUM * routingWeight(this.policy, candidate.id),
        );
      plan = calculate();
    }
    return { plan, credits, round };
  }

  reserve(
    candidates: readonly RoutingCandidate[],
    request: RoutingRequest,
    expectedRevision?: number,
  ): RoutingReservation {
    return this.reserveResolved(candidates, request, expectedRevision);
  }

  private reserveResolved(
    candidates: readonly RoutingCandidate[],
    request: RoutingRequest,
    expectedRevision?: number,
    directory?: RoutingDirectory,
    now = this.now(),
  ): RoutingReservation {
    request.signal?.throwIfAborted();
    if (
      (request.workUnits !== undefined &&
        (!Number.isFinite(request.workUnits) || request.workUnits < 0)) ||
      Object.values(request.demands ?? {}).some((value) => !Number.isFinite(value) || value < 0) ||
      [request.tokens?.input, request.tokens?.output, request.tokens?.total].some(
        (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
      )
    )
      throw new RoutingError("invalid-work-estimate");
    if (this.closed) throw new RoutingError("owner-stale");
    if (request.deadline !== undefined && request.deadline <= now)
      throw new RoutingError("attempt-expired");
    if (
      request.createdAt !== undefined &&
      (request.createdAt > now + 5000 || request.createdAt + 300000 <= now)
    )
      throw new RoutingError("attempt-expired");
    const key = JSON.stringify([request.scopeKey, request.attemptId]);
    const fingerprint = JSON.stringify([
      // 模型也是幂等输入；同 attempt 不能把旧模型的预留借给另一模型。
      request.modelKey,
      request.createdAt,
      request.turnId,
      request.workUnits,
      request.demands,
      request.tokens,
      directory ? "directory" : candidates.map((candidate) => [candidate.id, candidate.generation]),
    ]);
    const previous = this.attempts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new RoutingError("attempt-conflict");
      return previous.lease;
    }
    if (this.attempts.size >= 8192)
      throw new RoutingError("quota-owner-capacity", { phase: "admission" });
    if (expectedRevision !== undefined && expectedRevision !== this.revision)
      throw new RoutingError("policy-conflict");
    for (const candidate of candidates)
      this.synchronizeCredit(candidate, QUANTUM * routingWeight(this.policy, candidate.id));
    if (!directory)
      for (const candidate of candidates)
        for (const window of candidate.windows) this.ledger.observe(window);
    const { plan, credits, round } = this.decision(candidates, request, directory, now);
    const chosen = candidates.find((candidate) => candidate.id === plan.routes[0]);
    if (!chosen)
      throw new RoutingError(
        plan.reason === "binding-blocked"
          ? plan.reason
          : (Object.values(plan.excluded)[0] ?? "no-compatible-route"),
        {
          phase: "admission",
          dispatch: "unsent",
          ...(Object.values(plan.excluded).includes("route-cooling")
            ? { retryAt: Math.max(0, ...candidates.map((c) => c.availableAt ?? 0)) || undefined }
            : {}),
        },
      );
    const present = new Set(directory ? [] : candidates.map((candidate) => candidate.id));
    const leading = directory ? [] : (this.policy.order?.filter((id) => present.has(id)) ?? []);
    const seen = new Set(leading);
    const orderedIds = directory
      ? []
      : [...leading, ...candidates.map((candidate) => candidate.id).filter((id) => !seen.has(id))];
    const nextCursor = directory
      ? (directory.order.get(chosen.id)! + 1) % directory.ids.length
      : (orderedIds.indexOf(chosen.id) + 1) % Math.max(1, orderedIds.length);
    return this.reserveChosen(
      chosen,
      candidates,
      request,
      plan,
      credits,
      round,
      fingerprint,
      key,
      nextCursor,
      this.policy.strategy,
    );
  }

  setDirectory(
    ids: readonly string[],
    read: (id: string, request?: RoutingRequest) => RoutingCandidate,
  ): void {
    this.directory = new RoutingDirectory(ids, read, this.policy.order);
  }
  touchDirectory(id: string): void {
    this.directory?.touch(id, (candidate, request) => this.classify(candidate, request));
    if (this.directory?.read(id).windows.some((window) => window.shared && !window.coordinated))
      this.directory.touchGroupFor(id, (candidate, request) => this.classify(candidate, request));
  }
  touchQuotaGroup(poolId: string): void {
    this.directory?.touchGroup(poolId, (candidate, request) => this.classify(candidate, request));
  }
  private classify(candidate: RoutingCandidate, request: RoutingRequest, now = this.now()) {
    this.synchronizeCredit(candidate, QUANTUM * routingWeight(this.policy, candidate.id));
    for (const window of candidate.windows) this.ledger.observe(window);
    const projected = this.history.project(
      candidate,
      now,
      (window) => this.ledger.available(window),
      request.modelKey,
    );

    const measure = (value: RoutingCandidate) =>
      planRouting(this.policy, [value], request, {
        revision: this.revision,
        now,
        inFlight: this.inFlight,
        credit: this.credit,
        cursor: 0,
        ledger: this.ledger,
        orderIndex: this.directory?.order,
      });
    const ranked = measure(projected);
    const quantum = QUANTUM * routingWeight(this.policy, candidate.id);
    const credit = this.credit.get(candidate.id) ?? quantum;
    const eligibleRound =
      (this.creditedRound.get(candidate.id) ?? 0) +
      (credit > 0 ? 0 : Math.floor(-credit / quantum) + 1);
    const expiry = projected.expiry;
    return {
      rank: {
        candidate: projected,
        index: this.directory!.order.get(candidate.id)!,
        tier: ranked.tiers?.[candidate.id] ?? 0,
        pressure: ranked.pressures[candidate.id] ?? 0,
        load: (this.inFlight.get(candidate.id) ?? 0) / routingConcurrency(this.policy, candidate),
        concurrency: routingConcurrency(this.policy, candidate),
        quota: ranked.quotaScores?.[candidate.id],
        eligible: !ranked.excluded[candidate.id],
        eligibleRound,
        now,
        expires: Math.min(
          candidate.availableAt !== undefined && candidate.availableAt > now
            ? candidate.availableAt
            : Infinity,
          this.history.nextChange(candidate, now, request.modelKey),
          ...candidate.windows
            .flatMap((window) => [window.resetAt, window.expiresAt])
            .filter((at): at is number => at !== undefined && at > now),
          ...[expiry?.expiresAt, expiry ? expiry.expiresAt - 3_600_000 : undefined].filter(
            (at): at is number => at !== undefined && at > now,
          ),
          expiry && !candidate.expiry && this.policy.strategy === "expiry-first"
            ? now + 1
            : Infinity,
        ),
      },
      expires: Math.min(
        candidate.availableAt !== undefined && candidate.availableAt > now
          ? candidate.availableAt
          : Infinity,
        this.history.nextChange(candidate, now, request.modelKey),
        ...candidate.windows
          .filter((window) => !window.shared)
          .flatMap((window) =>
            [window.resetAt, window.expiresAt].filter(
              (at): at is number => at !== undefined && at > now,
            ),
          ),
      ),
    };
  }
  *prepareIndexed(request: RoutingRequest): Generator<void, void, void> {
    const directory = this.directory,
      epoch = this.policyEpoch;
    if (!directory) throw new RoutingError("no-compatible-route");
    const steps = directory.prepare(
      request,
      (candidate, input) => this.classify(candidate, input),
      this.now,
    );
    for (;;) {
      request.signal?.throwIfAborted();
      if (this.closed) throw new RoutingError("owner-stale");
      if (
        (request.deadline !== undefined && request.deadline <= this.now()) ||
        (request.createdAt !== undefined && request.createdAt + 300000 <= this.now())
      )
        throw new RoutingError("attempt-expired");
      if (directory !== this.directory || epoch !== this.policyEpoch)
        throw new RoutingError("policy-conflict");
      if (steps.next().done) return;
      yield;
    }
  }
  indexReady(request: RoutingRequest): boolean {
    return this.directory?.ready(request, this.now()) ?? false;
  }
  reserveIndexed(request: RoutingRequest): RoutingReservation {
    const now = this.now();
    const directory = this.directory;
    if (!directory) throw new RoutingError("no-compatible-route");
    const previous = this.attempts.has(JSON.stringify([request.scopeKey, request.attemptId]));
    const binding = this.bindings.get(request.scopeKey, request.turnId);
    const candidates = previous
      ? []
      : directory.select(
          request,
          this.cursor,
          (candidate, input) => this.classify(candidate, input, now),
          now,
          binding?.routeId,
          this.round,
        );
    return this.reserveResolved(candidates, request, undefined, directory, now);
  }
  indexDiagnostics() {
    return this.directory?.inspect();
  }
  routingInFlight(id: string): number {
    return this.inFlight.get(id) ?? 0;
  }
  get routingRevision(): number {
    return this.revision;
  }

  observeQuota(window: RoutingWindow): void {
    this.ledger.observe(window);
    this.revision++;
  }
  override dispose(): void {
    super.dispose();
    this.directory = undefined;
  }
}
