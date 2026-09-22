import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import {
  isLiveOutputPhase,
  readLiveOutputObservation,
  readStreamingOutputRate,
  recordStreamingOutputSample,
  retainObservedOutputRate,
  type LiveOutputTracker,
} from "./sessionTokenStats.js";

interface SessionRate {
  turnKey: string;
  tracker: LiveOutputTracker | null;
  rate: number | null;
}

function readTurnKey(snapshot: ConversationSnapshot): string | null {
  const turnId = snapshot.rows.window.at(-1)?.turnId;
  return turnId ? `${snapshot.logEpoch}\0${turnId}` : null;
}

/** Renderer 内的近期可见输出速率；不写回会话投影或持久化。 */
export class LiveOutputRateRegistry {
  private readonly rates = new Map<string, SessionRate>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly maxSessions = 256) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  read(snapshot: ConversationSnapshot | null | undefined): number | null {
    if (!snapshot || !isLiveOutputPhase(snapshot.control.phase)) return null;
    const entry = this.rates.get(snapshot.sessionId);
    return entry && entry.turnKey === readTurnKey(snapshot) ? entry.rate : null;
  }

  observe(snapshot: ConversationSnapshot, at = Date.now()): void {
    if (!isLiveOutputPhase(snapshot.control.phase)) {
      this.invalidate(snapshot.sessionId);
      return;
    }
    const turnKey = readTurnKey(snapshot);
    if (!turnKey) {
      this.invalidate(snapshot.sessionId);
      return;
    }

    const previous = this.rates.get(snapshot.sessionId);
    const sameTurn = previous?.turnKey === turnKey;
    const observation = readLiveOutputObservation(snapshot);
    const tracker = observation
      ? recordStreamingOutputSample(sameTurn ? previous.tracker : null, observation.sample, at)
      : sameTurn
        ? previous.tracker
        : null;
    const measured = observation ? readStreamingOutputRate(tracker, at) : null;
    const rate = retainObservedOutputRate(sameTurn ? previous.rate : null, measured);
    this.rates.delete(snapshot.sessionId);
    this.rates.set(snapshot.sessionId, { turnKey, tracker, rate });
    // Bug 原因：切换 pane 会销毁局部 hook 的采样器；按连接保留有界会话状态，
    // 但不为了计速延长 SessionDataLayer 的订阅或缓存历史终态。
    if (this.rates.size > this.maxSessions) {
      this.rates.delete(this.rates.keys().next().value!);
    }
    if (!sameTurn || previous.rate !== rate) this.notify();
  }

  invalidate(sessionId: string): void {
    if (!this.rates.delete(sessionId)) return;
    this.notify();
  }

  clear(): void {
    if (this.rates.size === 0) return;
    this.rates.clear();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function observeLiveOutputRateStore(
  store: Pick<ConversationProjectionStore, "getState" | "subscribe">,
  rates: LiveOutputRateRegistry,
  sessionId: string,
): () => void {
  let observedLive = false;
  let lastObservedSnapshot = store.getState().snapshot;
  return store.subscribe(() => {
    const { status, snapshot } = store.getState();
    if (status === "live") {
      observedLive = true;
      // 重连 ACK 先恢复 live，后续 notification 才替换快照；不重放旧样本。
      if (snapshot && snapshot !== lastObservedSnapshot) {
        lastObservedSnapshot = snapshot;
        rates.observe(snapshot);
      }
    } else if (status === "error" || (observedLive && status === "connecting")) {
      // 投影断链后不能把旧采样误当作本次连接的实时速度。
      observedLive = false;
      rates.invalidate(sessionId);
    }
  });
}
