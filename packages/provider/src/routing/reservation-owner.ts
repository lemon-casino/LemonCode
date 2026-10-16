import type {
  RoutingCandidate,
  RoutingRequest,
  RoutingPlan,
  RoutingFinish,
  RoutingStrategy,
} from "@lcode/shared/provider-routing";
import { RoutingLedger } from "./ledger.js";
import { RoutingHistory, routingHealthRelevant } from "./history.js";
import { RoutingBindings } from "./bindings.js";
import { routingDemand } from "./values.js";
import { routingWindowKey, type RoutingBinding } from "./planner.js";
import { RoutingError } from "./error.js";
export interface RoutingReservation {
  readonly routeId: string;
  readonly createdAt: number;
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

/** 调度 owner 的租约与对账部分；没有第二份状态、队列或 IO。 */
export abstract class RoutingReservationOwner {
  private lastDecision?: {
    sequence: number;
    requestedStrategy: RoutingStrategy;
    effectiveStrategy: RoutingStrategy;
    fallbackReason?: string;
    routeId: string;
    cacheDecision?: RoutingPlan["cacheDecision"];
    phase: "reserved" | "dispatched" | "cancelled" | "ended";
    outcome?: RoutingFinish["outcome"];
  };
  protected readonly ledger = new RoutingLedger();
  protected readonly history = new RoutingHistory();
  protected readonly inFlight = new Map<string, number>();
  protected readonly credit = new Map<string, number>();
  protected readonly creditedRound = new Map<string, number>();
  private readonly pausedCredit = new Set<string>();
  /** 禁用/冷却期间不累加轮次信用；恢复仅保留暂停时的一轮上限，负债不清零。 */
  protected synchronizeCredit(candidate: RoutingCandidate, quantum: number): void {
    const paused = Boolean(candidate.unavailable || candidate.health === "open");
    if (paused && !this.pausedCredit.has(candidate.id)) {
      const credit =
        (this.credit.get(candidate.id) ?? quantum) +
        (this.round - (this.creditedRound.get(candidate.id) ?? this.round)) * quantum;
      this.credit.set(candidate.id, Math.min(quantum, credit));
      this.creditedRound.set(candidate.id, this.round);
      this.pausedCredit.add(candidate.id);
    } else if (!paused && this.pausedCredit.delete(candidate.id))
      this.creditedRound.set(candidate.id, this.round);
  }
  protected readonly attempts = new Map<string, Attempt>();
  protected readonly bindings = new RoutingBindings();
  protected cursor = 0;
  protected revision = 0;
  protected sequence = 0;
  protected selections = 0;
  protected policyEpoch = 0;
  protected round = 0;
  protected closed = false;
  constructor(protected readonly now: () => number) {}
  protected abstract touchDirectory(id: string): void;
  protected reserveChosen(
    chosen: RoutingCandidate,
    candidates: readonly RoutingCandidate[],
    request: RoutingRequest,
    plan: RoutingPlan,
    credits: ReadonlyMap<string, number>,
    round: number,
    fingerprint: string,
    key: string,
    nextCursor: number,
    requestedStrategy: RoutingStrategy,
  ): RoutingReservation {
    const createdAt = this.now();
    const sequence = ++this.sequence;
    const policyEpoch = this.policyEpoch;
    this.lastDecision = {
      sequence,
      requestedStrategy,
      phase: "reserved",
      effectiveStrategy: plan.effectiveStrategy,
      fallbackReason: plan.fallbackReason,
      routeId: chosen.id,
      ...(plan.cacheDecision ? { cacheDecision: { ...plan.cacheDecision } } : {}),
    };
    this.selections++;
    const windows = chosen.windows.map((window) => ({ ...window }));
    const demand: Record<string, number> = { ...request.demands };
    for (const window of windows) {
      const amount = routingDemand(request.demands, window.resourceId, window.unit, request.tokens);
      if (amount !== undefined) demand[window.resourceId] = amount;
    }
    const plannedIds = new Set(plan.routes);
    const readings = new Map(
      candidates
        .filter((candidate) => plannedIds.has(candidate.id))
        .flatMap((candidate) =>
          candidate.windows.map((window) => [routingWindowKey(window), window.revision] as const),
        ),
    );
    const initialBinding: RoutingBinding = {
      cacheGroupId: chosen.cacheGroupId,
      routeId: chosen.id,
      generation: chosen.generation,
      turnId: request.turnId,
      portability: chosen.portability,
      cacheUntil: 0,
      pressure: plan.pressures[chosen.id] ?? 0,
      readingRevision: Math.max(0, ...windows.map((window) => window.revision)),
      readingSequence: this.ledger.readingSequence,
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
    this.cursor = nextCursor;
    this.revision++;
    const state: Attempt = {
      fingerprint,
      active: true,
      dispatched: false,
      settled: false,
      lease: undefined!,
    };
    let workObserved = false;
    const demandsObserved = new Set<string>();
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
      let outcomeChanged = false;
      if (!outcomeObserved && result.outcome !== undefined && result.outcome !== "unknown") {
        outcomeChanged = true;
        outcomeObserved = true;
        outcome = result.outcome;
        if (this.lastDecision?.sequence === sequence) this.lastDecision.outcome = outcome;
        usage = { ...usage, statusCode: result.statusCode };
        replaySafeFailure = Boolean(result.replaySafeFailure);
        if (sample) {
          sample.failed = outcome === "failed";
          sample.resolved = routingHealthRelevant({ ...usage, outcome });
        }
        if (physicalComplete) {
          if (outcome === "success") binding.confirm({ ...initialBinding, cacheUntil });
          else if (result.replaySafeFailure) binding.reject();
        }
      }
      if (result.actualDemands === undefined && result.workUnits === undefined) {
        // 迟到的成功可能只有 outcome；恢复许可与健康已变化，也必须刷新原目录，不能等下一笔 usage。
        if (outcomeChanged) this.touchDirectory(chosen.id);
        return;
      }
      const actualDemands: Record<string, number> = {};
      for (const [id, amount] of Object.entries(result.actualDemands ?? {})) {
        if (demandsObserved.has(id)) continue;
        demandsObserved.add(id);
        actualDemands[id] = amount;
      }
      // 每种已知量分别幂等：输入先到不能阻止总量晚到，也不能覆盖已接收输入。
      const acceptWork = !workObserved && result.workUnits !== undefined;
      if (acceptWork) workObserved = true;
      usage = {
        ...usage,
        ...(Object.keys(actualDemands).length
          ? { actualDemands: { ...usage.actualDemands, ...actualDemands } }
          : {}),
        ...(acceptWork ? { workUnits: result.workUnits } : {}),
      };
      if (sample) sample.usage = usage;
      if (state.settled && Object.keys(actualDemands).length)
        this.ledger.reconcile(windows, sequence, actualDemands);
      if (acceptWork)
        this.credit.set(chosen.id, (this.credit.get(chosen.id) ?? 0) + work - result.workUnits!);
      this.touchDirectory(chosen.id);
    };
    const refreshIndex = () => this.touchDirectory(chosen.id);
    const release = () => {
      if (!state.active) return;
      state.active = false;
      const count = (this.inFlight.get(chosen.id) ?? 1) - 1;
      if (count) this.inFlight.set(chosen.id, count);
      else this.inFlight.delete(chosen.id);
      this.revision++;
      refreshIndex();
    };
    const lease: RoutingReservation = {
      routeId: chosen.id,
      createdAt,
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
        if (this.lastDecision?.sequence === sequence) this.lastDecision.phase = "dispatched";
        this.ledger.dispatch(windows, sequence);
        binding.dispatch();
        started = this.now();
        return true;
      },
      cancel: () => {
        if (state.dispatched || state.settled) return;
        state.settled = true;
        this.selections--;
        if (this.lastDecision?.sequence === sequence) this.lastDecision.phase = "cancelled";
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
          sample = this.history.record(
            chosen,
            this.now(),
            started,
            {
              ...usage,
              outcome: outcome ?? result.outcome,
            },
            request.modelKey,
          );
        binding.finish(
          (outcome ?? result.outcome) !== "failed" &&
            (outcome ?? result.outcome) !== "cancelled" &&
            (outcome ?? result.outcome) !== "unknown"
            ? { ...initialBinding, cacheUntil }
            : undefined,
          result.replaySafeFailure || replaySafeFailure,
        );
        if (this.lastDecision?.sequence === sequence) {
          this.lastDecision.phase = "ended";
          this.lastDecision.outcome = outcome ?? result.outcome;
        }
        physicalComplete = true;
        release();
      },
      observeUsage,
    };
    state.lease = lease;
    this.attempts.set(key, state);
    this.touchDirectory(chosen.id);
    return lease;
  }

  readDiagnostics() {
    return {
      source: "local-owner" as const,
      asOf: this.now(),
      revision: this.revision,
      reservations: this.inFlight.size
        ? [...this.inFlight.values()].reduce((sum, value) => sum + value, 0)
        : 0,
      attempts: this.attempts.size,
      lastDecision: this.lastDecision ? structuredClone(this.lastDecision) : undefined,
      ...this.ledger.inspect(),
    };
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
    this.pausedCredit.clear();
  }
}
