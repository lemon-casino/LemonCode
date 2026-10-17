import type { StartupSurface } from "@lcode/shared/startup-animation";

/** 只管理欢迎的展示交接；卡片及其进入/取消命令始终由 Root 渲染和处理。 */
export function createStartupWelcome(root: HTMLElement | null, enabled: boolean, holdAt: number) {
  let surface: StartupSurface = "loading",
    time = 0,
    visible = false;
  const card = () => root?.querySelector<HTMLElement>('[data-startup-welcome="true"]');
  return {
    get visible() {
      return visible;
    },
    ownsFocus() {
      return card()?.contains(document.activeElement) ?? false;
    },
    sync(next?: StartupSurface, seconds = time) {
      surface = next ?? surface;
      time = seconds;
      const show =
        enabled && surface === "welcome" && (visible || time >= holdAt) && Boolean(card());
      if (show === visible) return;
      visible = show;
      document.documentElement.classList.toggle("lcode-startup-welcome", show);
      if (root) root.inert = !show;
      if (show)
        card()
          ?.querySelector<HTMLElement>("button:not([disabled])")
          ?.focus({ preventScroll: true });
    },
    dispose() {
      visible = false;
      document.documentElement.classList.remove("lcode-startup-welcome");
    },
  };
}
