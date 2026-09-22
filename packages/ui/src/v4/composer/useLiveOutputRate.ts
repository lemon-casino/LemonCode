import { useCallback, useSyncExternalStore } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

export function useLiveOutputRate(
  snapshot: ConversationSnapshot | null | undefined,
): number | null {
  const { layer } = useV4Conversation();
  const rates = layer.liveOutputRates;
  const subscribe = useCallback((listener: () => void) => rates.subscribe(listener), [rates]);
  const getSnapshot = useCallback(() => rates.read(snapshot), [rates, snapshot]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
