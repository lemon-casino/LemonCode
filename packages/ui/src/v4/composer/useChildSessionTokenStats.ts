import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import {
  aggregateChildSessionUsage,
  readStreamingOutputRate,
  readStreamingOutputSample,
  recordStreamingOutputSample,
  retainObservedOutputRate,
  type LiveOutputTracker,
} from "./sessionTokenStats.js";

export function useChildSessionTokenStats(
  layer: SessionDataLayer,
  childSessionIds: readonly string[],
) {
  const idKey = childSessionIds.join("\0");
  const leases = useMemo(
    () => (idKey ? idKey.split("\0").map((id) => layer.acquire(id)) : []),
    [idKey, layer],
  );
  useEffect(() => () => leases.forEach((lease) => lease.release()), [leases]);

  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = leases.map((lease) => lease.store.subscribe(listener));
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    [leases],
  );
  const getVersion = useCallback(
    () =>
      leases
        .map(({ store }) => {
          const { status, snapshot } = store.getState();
          return `${status}:${snapshot?.seq ?? ""}:${snapshot?.revision ?? ""}`;
        })
        .join("|"),
    [leases],
  );
  const version = useSyncExternalStore(subscribe, getVersion, () => "");
  const snapshots = useMemo(
    () => leases.map(({ store }) => store.getState().snapshot),
    [leases, version],
  );
  const usage = useMemo(() => aggregateChildSessionUsage(snapshots), [snapshots]);
  const runningSessionIds = useMemo(
    () =>
      snapshots.flatMap((snapshot, index) =>
        snapshot?.control.phase === "running" ? [leases[index]!.sessionId] : [],
      ),
    [leases, snapshots],
  );
  const runningKey = runningSessionIds.join("\0");
  const activeSamples = useMemo(
    () =>
      snapshots.flatMap((snapshot, index) => {
        if (snapshot?.control.phase !== "running") return [];
        const sample = readStreamingOutputSample(snapshot.rows.window);
        const sessionId = leases[index]!.sessionId;
        return sample ? [{ sessionId, key: `${sessionId}\0${sample.responseId}`, sample }] : [];
      }),
    [leases, snapshots],
  );
  const currentOutputTokens = activeSamples.reduce(
    (sum, { sample }) => sum + sample.estimatedTokens,
    0,
  );
  const trackers = useRef(new Map<string, LiveOutputTracker>());
  const [displayRates, setDisplayRates] = useState<Map<string, number>>(() => new Map());

  useEffect(() => {
    const currentKeys = new Set(activeSamples.map(({ key }) => key));
    for (const key of trackers.current.keys()) {
      if (!currentKeys.has(key)) trackers.current.delete(key);
    }
    const time = Date.now();
    const measured = new Map<string, number>();
    for (const { sessionId, key, sample } of activeSamples) {
      const tracker = recordStreamingOutputSample(trackers.current.get(key) ?? null, sample, time);
      trackers.current.set(key, tracker);
      const rate = readStreamingOutputRate(tracker, time);
      if (rate !== null && rate > 0) measured.set(sessionId, rate);
    }
    const running = new Set(runningKey ? runningKey.split("\0") : []);
    setDisplayRates((previous) => {
      const next = new Map(previous);
      let changed = false;
      for (const id of next.keys()) {
        if (running.has(id)) continue;
        next.delete(id);
        changed = true;
      }
      for (const [id, rate] of measured) {
        const retained = retainObservedOutputRate(next.get(id) ?? null, rate);
        if (retained === null || retained === next.get(id)) continue;
        next.set(id, retained);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [activeSamples, runningKey]);

  const observedRates = runningSessionIds.flatMap((id) => {
    const rate = displayRates.get(id);
    return rate === undefined ? [] : [rate];
  });
  return {
    usage,
    currentOutputTokens: activeSamples.length ? currentOutputTokens : null,
    liveOutputRate: observedRates.length
      ? observedRates.reduce((sum, rate) => sum + rate, 0)
      : null,
    childCount: leases.length,
  };
}
