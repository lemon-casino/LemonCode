import {
  providerRoutingPolicySchema,
  type ProviderRoutingPolicy,
  type RoutingCandidate,
  type RoutingFinish,
  type RoutingPlan,
  type RoutingRequest,
  type RoutingWindow,
} from "@lcode/shared/provider-routing";
import { RoutingLedger } from "./ledger.js";
import { planRouting, routingWindowKey, type RoutingBinding } from "./planner.js";
import { RoutingHistory } from "./history.js";
import { routingWeight } from "./values.js";
import { RoutingBindings } from "./bindings.js";
import { RoutingError } from "./error.js";

const QUANTUM = 4096;
export interface RoutingReservation {
  readonly routeId: string;
  readonly sequence: number;
  dispatch(): boolean;
  cancel(): void;
  finish(result: RoutingFinish): void;
  observeUsage(result: RoutingFinish): void;
}
interface Attempt {
  fingerprint: string;
  lease: RoutingReservation;
  active: boolean;
  dispatched: boolean;
  settled: boolean;
}

/** 同步 mutation 由原执行 owner 调用，类本身无 IO、定时器或业务队列。 */
export class RoutingScheduler {
  private policy: ProviderRoutingPolicy;
  private readonly now: () => number;
  private readonly ledger = new RoutingLedger();
  private readonly history = new RoutingHistory();
  private readonly inFlight = new Map<string, number>();
  private readonly credit = new Map<string, number>();
  private readonly creditedRound = new Map<string, number>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly bindings = new RoutingBindings();
  private cursor = 0;
  private revision = 0;
  private sequence = 0;
  private selections = 0;
  private policyEpoch = 0;
  private round = 0;
  private closed = false;

  constructor(policy: ProviderRoutingPolicy, options: { now?: () => number } = {}) {
    this.policy = providerRoutingPolicySchema.parse(policy);
    this.now = options.now ?? Date.now;
  }

  plan(candidates: readonly RoutingCandidate[], request: RoutingRequest): RoutingPlan {
    return this.decision(candidates, request).plan;
  }

  setPolicy(policy: ProviderRoutingPolicy): void {
    this.policy = providerRoutingPolicySchema.parse(policy);
    this.revision++;
    this.policyEpoch++;
  }

  private decision(candidates: readonly RoutingCandidate[], request: RoutingRequest) {
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
    const now = this.now();
    const projected = candidates.map((candidate) =>
      this.history.project(candidate, now, (window) => this.ledger.available(window)),
    );
    const calculate = () =>
      planRouting(this.policy, projected, request, {
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
    if (
      plan.effectiveStrategy === "share-rotation" &&
      plan.routes.length &&
      plan.routes.every((id) => (credits.get(id) ?? 0) <= 0)
    ) {
      const steps = Math.min(
        ...plan.routes.map(
          (id) =>
            Math.floor(-(credits.get(id) ?? 0) / (QUANTUM * routingWeight(this.policy, id))) + 1,
        ),
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
    request.signal?.throwIfAborted();
    if (
      (request.workUnits !== undefined &&
        (!Number.isFinite(request.workUnits) || request.workUnits < 0)) ||
      Object.values(request.demands ?? {}).some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new RoutingError("invalid-work-estimate");
    if (this.closed) throw new RoutingError("owner-stale");
    if (request.deadline !== undefined && request.deadline <= this.now())
      throw new RoutingError("attempt-expired");
    const key = JSON.stringify([request.scopeKey, request.attemptId]);
    const fingerprint = JSON.stringify([
      request.turnId,
      request.workUnits,
      request.demands,
      candidates.map((candidate) => [candidate.id, candidate.generation]),
    ]);
    const previous = this.attempts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new RoutingError("attempt-conflict");
      return previous.lease;
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision)
      throw new RoutingError("policy-conflict");
    const { plan, credits, round } = this.decision(candidates, request);
    const chosen = candidates.find((candidate) => candidate.id === plan.routes[0]);
    if (!chosen)
      throw new RoutingError(
        plan.reason === "binding-blocked"
          ? plan.reason
          : (Object.values(plan.excluded)[0] ?? "no-compatible-route"),
      );
    const sequence = ++this.sequence;
    const policyEpoch = this.policyEpoch;
    this.selections++;
    const demand = Object.freeze({ ...request.demands });
    const windows = chosen.windows.map((window) => ({ ...window }));
    const plannedIds = new Set(plan.routes);
    const readings = new Map(
      candidates
        .filter((candidate) => plannedIds.has(candidate.id))
        .flatMap((candidate) =>
          candidate.windows.map((window) => [routingWindowKey(window), window.revision] as const),
        ),
    );
    const initialBinding: RoutingBinding = {
      routeId: chosen.id,
      generation: chosen.generation,
      turnId: request.turnId,
      portability: chosen.portability,
      cacheUntil: 0,
      pressure: plan.pressures[chosen.id] ?? 0,
      readingRevision: Math.max(0, ...windows.map((window) => window.revision)),
      readings,
    };
    const binding = this.bindings.reserve(request, chosen, sequence, initialBinding);
    const work = request.workUnits ?? 1;
    this.ledger.reserve(windows, sequence, demand);
    this.inFlight.set(chosen.id, (this.inFlight.get(chosen.id) ?? 0) + 1);
    this.round = round;
    const oldCredit = credits.get(chosen.id)!;
    this.creditedRound.set(chosen.id, round);
    this.credit.set(chosen.id, oldCredit - work);
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const listedOrder = this.policy.order?.filter((id) => candidateIds.has(id)) ?? [];
    const orderedIds = new Set(listedOrder);
    const ordered = [
      ...listedOrder,
      ...candidates.map((candidate) => candidate.id).filter((id) => !orderedIds.has(id)),
    ];
    this.cursor = (ordered.indexOf(chosen.id) + 1) % Math.max(1, ordered.length);
    this.revision++;
    const state: Attempt = {
      fingerprint,
      active: true,
      dispatched: false,
      settled: false,
      lease: undefined!,
    };
    let usageObserved = false;
    let outcomeObserved = false,
      physicalComplete = false,
      cacheUntil = 0;
    let outcome: RoutingFinish["outcome"];
    let replaySafeFailure = false;
    let started = this.now();
    let usage: RoutingFinish = {};
    let sample: ReturnType<RoutingHistory["record"]> | undefined;
    const validateUsage = (result: RoutingFinish) => {
      if (
        result.workUnits !== undefined &&
        (!Number.isFinite(result.workUnits) || result.workUnits < 0)
      )
        throw new RoutingError("invalid-usage");
      if (
        Object.values(result.actualDemands ?? {}).some(
          (value) => !Number.isFinite(value) || value < 0,
        )
      )
        throw new RoutingError("invalid-usage");
    };
    const observeUsage = (result: RoutingFinish) => {
      if (this.closed) return;
      validateUsage(result);
      if (!outcomeObserved && result.outcome !== undefined && result.outcome !== "unknown") {
        outcomeObserved = true;
        outcome = result.outcome;
        replaySafeFailure = Boolean(result.replaySafeFailure);
        if (sample) {
          sample.failed = outcome === "failed";
          sample.resolved = outcome !== "cancelled";
        }
        if (physicalComplete) {
          if (outcome === "success") binding.confirm({ ...initialBinding, cacheUntil });
          else if (result.replaySafeFailure) binding.reject();
        }
      }
      if (usageObserved) return;
      if (result.actualDemands === undefined && result.workUnits === undefined) return;
      usageObserved = true;
      usage = { ...result };
      if (sample) sample.usage = usage;
      if (state.settled && result.actualDemands)
        this.ledger.reconcile(windows, sequence, result.actualDemands);
      if (result.workUnits !== undefined)
        this.credit.set(chosen.id, (this.credit.get(chosen.id) ?? 0) + work - result.workUnits);
    };
    const release = () => {
      if (!state.active) return;
      state.active = false;
      const count = (this.inFlight.get(chosen.id) ?? 1) - 1;
      if (count) this.inFlight.set(chosen.id, count);
      else this.inFlight.delete(chosen.id);
      this.revision++;
    };
    const lease: RoutingReservation = {
      routeId: chosen.id,
      sequence,
      dispatch: () => {
        request.signal?.throwIfAborted();
        if (policyEpoch !== this.policyEpoch && !state.dispatched) {
          lease.cancel();
          throw new RoutingError("policy-conflict");
        }
        if (this.closed || !state.active) throw new RoutingError("owner-stale");
        if (state.dispatched) return false;
        state.dispatched = true;
        binding.dispatch();
        started = this.now();
        return true;
      },
      cancel: () => {
        if (state.dispatched || state.settled) return;
        state.settled = true;
        this.selections--;
        binding.cancel();
        this.ledger.cancel(windows, sequence);
        this.credit.set(chosen.id, (this.credit.get(chosen.id) ?? 0) + work);
        release();
      },
      finish: (result) => {
        if (state.settled || this.closed) return;
        if (!state.dispatched) {
          lease.cancel();
          return;
        }
        validateUsage(result);
        state.settled = true;
        cacheUntil = result.cacheUntil ?? 0;
        this.ledger.finish(windows, sequence, result.actualDemands ?? usage.actualDemands);
        observeUsage(result);
        if (usage.actualDemands) this.ledger.reconcile(windows, sequence, usage.actualDemands);
        if (state.dispatched && result.outcome !== "cancelled")
          sample = this.history.record(chosen, this.now(), started, {
            ...usage,
            outcome: outcome ?? result.outcome,
          });
        binding.finish(
          (outcome ?? result.outcome) !== "failed" &&
            (outcome ?? result.outcome) !== "cancelled" &&
            (outcome ?? result.outcome) !== "unknown"
            ? { ...initialBinding, cacheUntil }
            : undefined,
          result.replaySafeFailure || replaySafeFailure,
        );
        physicalComplete = true;
        release();
      },
      observeUsage,
    };
    state.lease = lease;
    this.attempts.set(key, state);
    return lease;
  }

  observeQuota(window: RoutingWindow): void {
    this.ledger.observe(window);
    this.revision++;
  }
  inspect() {
    return {
      revision: this.revision,
      reservations: [...this.inFlight.values()].reduce((sum, value) => sum + value, 0),
      attempts: this.attempts.size,
      cursor: this.cursor,
      shares: [...this.credit],
    };
  }
  dispose(): void {
    this.closed = true;
    this.ledger.clear();
    this.history.clear();
    this.inFlight.clear();
    this.bindings.clear();
    this.attempts.clear();
    this.credit.clear();
    this.creditedRound.clear();
  }
}
