import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationSnapshot, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  readStreamingOutputRate,
  readStreamingOutputSample,
  recordStreamingOutputSample,
  retainObservedOutputRate,
  type LiveOutputTracker,
} from "./sessionTokenStats.js";

export function useLiveOutputRate(
  rows: ConversationSnapshot["rows"]["window"] | undefined,
  phase: SessionPhase | null,
  sessionId: string | null,
): number | null {
  const sample = useMemo(() => (rows ? readStreamingOutputSample(rows) : null), [rows]);
  const activeSessionId = phase === "running" && rows ? sessionId : null;
  const activeKey = activeSessionId && sample ? `${activeSessionId}\0${sample.responseId}` : null;
  const trackerRef = useRef<{ key: string; value: LiveOutputTracker } | null>(null);
  const [display, setDisplay] = useState<{ sessionId: string; rate: number | null } | null>(null);

  useEffect(() => {
    if (!activeSessionId) {
      trackerRef.current = null;
      setDisplay(null);
      return;
    }
    if (!activeKey || !sample) {
      trackerRef.current = null;
      return;
    }
    const previous = trackerRef.current?.key === activeKey ? trackerRef.current.value : null;
    const value = recordStreamingOutputSample(previous, sample, Date.now());
    trackerRef.current = { key: activeKey, value };
    const measured = readStreamingOutputRate(value, Date.now());
    setDisplay((current) => {
      const rate = retainObservedOutputRate(
        current?.sessionId === activeSessionId ? current.rate : null,
        measured,
      );
      return current?.sessionId === activeSessionId && current.rate === rate
        ? current
        : { sessionId: activeSessionId, rate };
    });
  }, [activeSessionId, activeKey, sample?.estimatedTokens]);

  // 工具和短暂停顿保留同一运行内上次测量，完成/切换会话立即隐藏旧读数。
  return display?.sessionId === activeSessionId ? display.rate : null;
}
