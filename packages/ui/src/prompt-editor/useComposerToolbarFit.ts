import { useLayoutEffect, useRef } from "react";

/** 仅拥有 DOM 布局投影；权限、Plan 和 CUA 业务状态仍由原有 hooks 管理。 */
export function fitComposerToolbar(root: HTMLElement) {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return;
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]"),
  ).sort(
    (a, b) =>
      Number(a.dataset.composerCollapsePriority) - Number(b.dataset.composerCollapsePriority),
  );
  // 无 compact 控件或模型的组合也必须走溢出终态，不能提前退出后让按钮被裁切。
  delete root.dataset.composerScroll;
  // 每次从完整布局测量，避免各按钮独立 observer 互相抢空间，也覆盖语言与异步入口变化。
  delete root.dataset.composerModelIcon;
  root.style.removeProperty("--composer-model-max-width");
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  const prefixLine = root.querySelector<HTMLElement>(".composer-provider-prefix")?.parentElement;
  if (prefixLine && prefixLine.scrollWidth > prefixLine.clientWidth) {
    root.dataset.composerProviderCompact = "true";
  }
  const fits = () =>
    content.getBoundingClientRect().width <= available.getBoundingClientRect().width + 0.5;
  for (const control of controls) {
    if (fits()) return;
    control.dataset.composerCompact = "true";
    if (control.dataset.composerCollapsePriority === "0" && !fits()) {
      root.dataset.composerProviderCompact = "true";
    }
  }
  if (!fits()) {
    root.dataset.composerProviderCompact = "true";
    const model = root.querySelector<HTMLElement>(".composer-model-trigger");
    if (model && !fits()) {
      const overflow =
        content.getBoundingClientRect().width - available.getBoundingClientRect().width;
      const modelWidth = Math.max(28, model.getBoundingClientRect().width - overflow);
      // 收起左侧文案后，剩余空间必须让给同一行的模型与发送按钮，不能靠换行掩盖溢出。
      if (modelWidth < 80) root.dataset.composerModelIcon = "true";
      else root.style.setProperty("--composer-model-max-width", `${modelWidth}px`);
    }
  }
  // 图标也放不下时保留全部非主动作，通过局部原生滚动访问；发送/停止在该区域外固定可见。
  if (!fits()) root.dataset.composerScroll = "true";
}

export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      if (!root.parentElement || root.getBoundingClientRect().width <= 0) return;
      // 在不可见副本上尝试展开，避免真实按钮测量时来回移动、丢失 hover 或关闭 Tooltip。
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${root.getBoundingClientRect().width}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        fitComposerToolbar(probe);
        for (const key of ["composerModelIcon", "composerProviderCompact", "composerScroll"]) {
          if (probe.dataset[key]) root.dataset[key] = probe.dataset[key];
          else delete root.dataset[key];
        }
        const modelMaxWidth = probe.style.getPropertyValue("--composer-model-max-width");
        if (modelMaxWidth) root.style.setProperty("--composer-model-max-width", modelMaxWidth);
        else root.style.removeProperty("--composer-model-max-width");
        const live = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        const measured = probe.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        live.forEach((control, index) => {
          if (measured[index]?.dataset.composerCompact) control.dataset.composerCompact = "true";
          else delete control.dataset.composerCompact;
        });
      } finally {
        probe.remove();
      }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(root);
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]",
      ))
        resize?.observe(element);
      update();
    };
    // 不观察布局属性自身，防止写 data-composer-compact 引起递归测量。
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
    };
  }, []);
  return ref;
}
