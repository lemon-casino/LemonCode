import { useLayoutEffect, useRef } from "react";

const MIN_PANEL_HEIGHT = 192;
const BOTTOM_CLEARANCE = 16;

/** 高度仅是布局投影：按当前容器测量，不能把 UI 几何作为服务端设置。 */
export function useModelSettingsAvailableHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    let container = panel.parentElement;
    while (container && !["auto", "scroll"].includes(getComputedStyle(container).overflowY))
      container = container.parentElement;
    const measure = () => {
      // 原固定视口偏移忽略了标题换行和 shell 高度，导致大屏浪费空间或小屏挤出底部。
      const bottom = container
        ? Math.min(innerHeight, container.getBoundingClientRect().bottom)
        : innerHeight;
      const height = Math.max(
        MIN_PANEL_HEIGHT,
        bottom - panel.getBoundingClientRect().top - BOTTOM_CLEARANCE,
      );
      const value = `${height}px`;
      if (panel.style.getPropertyValue("--model-settings-height") !== value)
        panel.style.setProperty("--model-settings-height", value);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (container) observer.observe(container);
    // 标题/描述换行改变父布局；自身高度写入再次回调时，同值不写，避免反馈循环。
    if (panel.parentElement?.parentElement) observer.observe(panel.parentElement.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return ref;
}
