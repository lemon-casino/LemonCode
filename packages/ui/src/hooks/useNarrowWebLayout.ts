import { useCallback, useMemo, useSyncExternalStore } from "react";

const NARROW_WEB_QUERY = "(width < 768px)";
const getServerSnapshot = () => false;

/** App 只订阅断点布尔值；键盘高度和原生 Desktop 都不参与 Web 抽屉策略。 */
export function useNarrowWebLayout(isDesktop: boolean): boolean {
  const media = useMemo(
    () =>
      !isDesktop && typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(NARROW_WEB_QUERY)
        : null,
    [isDesktop],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      media?.addEventListener("change", onChange);
      return () => media?.removeEventListener("change", onChange);
    },
    [media],
  );
  const getSnapshot = useCallback(() => media?.matches ?? false, [media]);

  // 不能等首次 resize 再修正：窄 Web 的第一个可交互 render 就必须给主会话完整宽度。
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
