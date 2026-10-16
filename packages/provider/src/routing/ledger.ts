import type { RoutingQuotaDiagnostic } from "./shared-quota.js";
import type { RoutingWindow } from "@lcode/shared/provider-routing";

interface Debit {
  sequence: number;
  amount: number;
  ended: boolean;
  dispatched: boolean;
  estimated: boolean;
}
interface Resource {
  reading: RoutingWindow;
  debits: Map<number, Debit>;
  total: number;
  observedAt: number;
}
const keyOf = (window: RoutingWindow) => JSON.stringify([window.resourceId, window.instanceId]);
const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

/** 只保存原额度 owner 的版本投影与本地待对账增量，不产生厂商额度事实。 */
export class RoutingLedger {
  private readonly resources = new Map<string, Resource>();
  private observationSequence = 0;
  get readingSequence(): number {
    return this.observationSequence;
  }
  changedSince(window: RoutingWindow, sequence: number): boolean {
    const resource = this.resources.get(keyOf(window));
    return (
      !resource || resource.observedAt > sequence || window.revision > resource.reading.revision
    );
  }

  observe(window: RoutingWindow): void {
    const key = keyOf(window),
      existing = this.resources.get(key);
    if (existing && existing.reading.revision >= window.revision) return;
    const resource = existing ?? {
      reading: window,
      debits: new Map<number, Debit>(),
      total: 0,
      observedAt: 0,
    };
    resource.reading = { ...window };
    resource.observedAt = ++this.observationSequence;
    // 读取完成时间不是覆盖证明；只有明确水位才退休已结算增量，在途消费不能清空。
    for (const [seq, debit] of resource.debits)
      if (debit.ended && window.coversThroughSeq !== undefined && seq <= window.coversThroughSeq) {
        resource.debits.delete(seq);
        resource.total -= debit.amount;
      }
    this.resources.set(key, resource);
  }

  reading(window: RoutingWindow): RoutingWindow {
    const current = this.resources.get(keyOf(window))?.reading;
    return current && current.revision > window.revision ? current : window;
  }

  available(window: RoutingWindow): number | undefined {
    const current = this.reading(window);
    if (!finite(current.remaining)) return undefined;
    return Math.max(0, current.remaining - (this.resources.get(keyOf(window))?.total ?? 0));
  }

  reserve(
    windows: readonly RoutingWindow[],
    sequence: number,
    demands: Readonly<Record<string, number>>,
  ): void {
    const seen = new Set<string>();
    for (const window of windows) {
      if (window.coordinated) continue;
      const key = keyOf(window);
      if (seen.has(key)) continue;
      seen.add(key);
      this.observe(window);
      const amount = demands[window.resourceId];
      if (finite(amount)) {
        this.resources.get(key)!.debits.set(sequence, {
          sequence,
          amount,
          ended: false,
          dispatched: false,
          estimated: true,
        });
        this.resources.get(key)!.total += amount;
      }
    }
  }

  dispatch(windows: readonly RoutingWindow[], sequence: number): void {
    for (const window of windows) {
      const debit = this.resources.get(keyOf(window))?.debits.get(sequence);
      if (debit) debit.dispatched = true;
    }
  }

  cancel(windows: readonly RoutingWindow[], sequence: number): void {
    for (const window of windows) {
      const resource = this.resources.get(keyOf(window)),
        debit = resource?.debits.get(sequence);
      if (debit) {
        resource!.total -= debit.amount;
        resource!.debits.delete(sequence);
      }
    }
  }

  finish(
    windows: readonly RoutingWindow[],
    sequence: number,
    actual?: Readonly<Record<string, number>>,
  ): void {
    for (const window of windows) {
      const resource = this.resources.get(keyOf(window));
      const debit = resource?.debits.get(sequence);
      if (!debit || debit.ended) continue;
      const amount = actual?.[window.resourceId];
      if (finite(amount)) {
        resource!.total += amount - debit.amount;
        debit.amount = amount;
        debit.estimated = false;
      }
      debit.ended = true;
      if (
        resource!.reading.coversThroughSeq !== undefined &&
        sequence <= resource!.reading.coversThroughSeq
      ) {
        resource!.debits.delete(sequence);
        resource!.total -= debit.amount;
      }
    }
  }

  reconcile(
    windows: readonly RoutingWindow[],
    sequence: number,
    actual: Readonly<Record<string, number>>,
  ): void {
    for (const window of windows) {
      // 外部共享 owner 已对账；本地不能因迟到 usage 再补出一份共享借记。
      if (window.coordinated) continue;
      const resource = this.resources.get(keyOf(window));
      const debit = resource?.debits.get(sequence);
      const amount = actual[window.resourceId];
      if (debit?.ended && finite(amount)) {
        resource!.total += amount - debit.amount;
        debit.amount = amount;
        debit.estimated = false;
      } else if (
        resource &&
        !debit &&
        finite(amount) &&
        (resource.reading.coversThroughSeq === undefined ||
          sequence > resource.reading.coversThroughSeq)
      ) {
        resource.debits.set(sequence, {
          sequence,
          amount,
          ended: true,
          dispatched: true,
          estimated: false,
        });
        resource.total += amount;
      }
    }
  }

  inspect() {
    const resources: RoutingQuotaDiagnostic[] = [];
    for (const resource of this.resources.values()) {
      if (resources.length === 100) break;
      let reserved = 0,
        dispatched = 0,
        endedActual = 0,
        endedEstimated = 0;
      for (const debit of resource.debits.values()) {
        if (debit.ended) {
          if (debit.estimated) endedEstimated += debit.amount;
          else endedActual += debit.amount;
        } else if (debit.dispatched) dispatched += debit.amount;
        else reserved += debit.amount;
      }
      const window = resource.reading;
      resources.push({
        resourceId: window.resourceId,
        instanceId: window.instanceId,
        readingRemaining: window.remaining,
        limit: window.limit,
        unit: window.unit,
        quality: window.quality,
        coveredThroughSeq: window.coversThroughSeq,
        reserved,
        dispatched,
        endedActual,
        endedEstimated,
        folded: 0,
        foldedUnknown: false,
        held: resource.total,
        available: this.available(window),
      });
    }
    return {
      resources,
      resourceCount: this.resources.size,
      resourcesTruncated: this.resources.size > resources.length,
    };
  }

  clear(): void {
    this.resources.clear();
  }
}
