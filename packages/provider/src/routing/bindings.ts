import type { RoutingCandidate, RoutingRequest } from "@lcode/shared/provider-routing";
import type { RoutingBinding } from "./planner.js";

const SOFT_BINDING_LIMIT = 4096;
interface Entry {
  binding: RoutingBinding;
  valid: boolean;
  previous?: Entry;
}
interface Turn {
  entry: Entry;
  references: number;
  unsafeDispatches: number;
}

/** 预留即锁定不可移植轮次；取消未派发引用时回滚，迟到旧轮终态不能覆盖新轮。 */
export class RoutingBindings {
  private readonly current = new Map<string, Entry>();
  private readonly turns = new Map<string, Turn>();
  private readonly latest = new Map<string, number>();
  private key(request: Pick<RoutingRequest, "scopeKey" | "turnId">) {
    return JSON.stringify([request.scopeKey, request.turnId]);
  }
  get(scopeKey: string, turnId?: string): RoutingBinding | undefined {
    return (
      (turnId !== undefined
        ? this.turns.get(this.key({ scopeKey, turnId }))?.entry.binding
        : undefined) ?? this.current.get(scopeKey)?.binding
    );
  }
  reserve(
    request: RoutingRequest,
    candidate: RoutingCandidate,
    sequence: number,
    initial: RoutingBinding,
  ) {
    const previousTurn = this.current.get(request.scopeKey)?.binding.turnId;
    if (previousTurn !== undefined && previousTurn !== request.turnId) {
      const previousKey = this.key({ scopeKey: request.scopeKey, turnId: previousTurn });
      if (this.turns.get(previousKey)?.references === 0) this.turns.delete(previousKey);
    }
    this.latest.set(request.scopeKey, sequence);
    const key = this.key(request);
    let turn: Turn | undefined;
    if (request.turnId !== undefined && candidate.portability !== "portable") {
      turn = this.turns.get(key);
      if (!turn) {
        turn = {
          entry: { binding: initial, valid: true, previous: this.current.get(request.scopeKey) },
          references: 0,
          unsafeDispatches: 0,
        };
        this.turns.set(key, turn);
      }
      turn.references++;
      this.current.set(request.scopeKey, turn.entry);
    }
    let released = false;
    const rollback = () => {
      if (!turn) return;
      if (!turn.references && !turn.unsafeDispatches) {
        turn.entry.valid = false;
        if (this.current.get(request.scopeKey) === turn.entry) {
          let previous = turn.entry.previous;
          while (previous && !previous.valid) previous = previous.previous;
          if (previous) this.current.set(request.scopeKey, previous);
          else this.current.delete(request.scopeKey);
        }
        this.turns.delete(key);
      }
    };
    const release = (cancelled: boolean) => {
      if (released) return;
      released = true;
      if (!turn) return;
      turn.references--;
      if (cancelled) rollback();
      if (!turn.references && this.current.get(request.scopeKey) !== turn.entry)
        this.turns.delete(key);
    };
    const confirm = (binding: RoutingBinding) => {
      if (this.latest.get(request.scopeKey) !== sequence) return;
      if (turn) {
        turn.entry.binding = binding;
        turn.entry.previous = undefined;
        this.current.set(request.scopeKey, turn.entry);
      } else this.current.set(request.scopeKey, { binding, valid: true });
    };
    return {
      dispatch: () => {
        if (turn) turn.unsafeDispatches++;
      },
      cancel: () => release(true),
      confirm,
      reject: () => {
        if (turn) {
          turn.unsafeDispatches--;
          rollback();
        }
      },
      finish: (binding?: RoutingBinding, replaySafeFailure = false) => {
        if (turn && replaySafeFailure) turn.unsafeDispatches--;
        if (binding) confirm(binding);
        release(replaySafeFailure);
      },
    };
  }
  /** 可移植且 TTL 已过的闲置软绑定可以丢弃；硬绑定和活跃轮次不按容量清除。 */
  compact(now: number): void {
    if (this.current.size <= SOFT_BINDING_LIMIT) return;
    for (const [scope, entry] of this.current) {
      if (this.current.size <= SOFT_BINDING_LIMIT) break;
      if (entry.binding.portability !== "portable" || entry.binding.cacheUntil > now) continue;
      this.current.delete(scope);
      this.latest.delete(scope);
    }
  }
  clear(): void {
    this.current.clear();
    this.turns.clear();
    this.latest.clear();
  }
}
