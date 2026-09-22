import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import {
  aggregateChildSessionUsage,
  isLiveOutputPhase,
  readLiveOutputObservation,
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
  const activeSamples = useMemo(
    () =>
      snapshots.flatMap((snapshot) => {
        const observation = readLiveOutputObservation(snapshot);
        if (!observation) return [];
        return [
          {
            sample: observation.sample,
          },
        ];
      }),
    [snapshots],
  );
  const currentOutputTokens = activeSamples.reduce(
    (sum, { sample }) => sum + sample.estimatedTokens,
    0,
  );
  const observedRates = snapshots.flatMap((snapshot) => {
    if (!snapshot || !isLiveOutputPhase(snapshot.control.phase)) return [];
    const rate = layer.liveOutputRates.read(snapshot);
    return rate === null ? [] : [rate];
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
