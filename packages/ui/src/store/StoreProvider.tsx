/**
 * StoreProvider —— 初始化 Zustand store 并通过 React Context 提供
 *
 * 在应用根部挂载，连接 broadcastService 实现跨窗口状态同步。
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { IBroadcastService } from "@lcode/services";
import { createLCodeStore, type LCodeStore, type LCodeState } from "./index.js";

// 导出 Context 供测试直接注入已构造的 store 实例（如跨窗口广播抑制用例）。
const StoreContext = createContext<LCodeStore | null>(null);

export function StoreProvider({
  broadcastService,
  initialIsRestoringOAuthSession = false,
  children,
}: {
  broadcastService: IBroadcastService;
  initialIsRestoringOAuthSession?: boolean;
  children: ReactNode;
}) {
  // 只在首次渲染时创建 store，避免 HMR 重复订阅
  const storeRef = useRef<LCodeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createLCodeStore(broadcastService, {
      initialIsRestoringOAuthSession,
    });
  }

  return <StoreContext.Provider value={storeRef.current}>{children}</StoreContext.Provider>;
}

/**
 * 消费 Zustand store 的 hook
 *
 * 用法：
 *   const theme = useLCodeStore(s => s.theme);
 *   const setTheme = useLCodeStore(s => s.setTheme);
 */
export function useLCodeStore<T>(selector: (state: LCodeState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useLCodeStore 必须在 StoreProvider 内使用");
  }
  return useStore(store, selector);
}

/**
 * 带默认值的容错版 useLCodeStore（store 耦合剥离配套）。
 *
 * 使用场景：宿主组件（PermissionDialog / 各 markdown 弹窗等）负责从 store 取
 * theme / codePreviewSettings，再通过 props 注入纯展示组件。这些宿主在单测里常被
 * 无 Provider 直接 renderToStaticMarkup，此时返回 defaultValue 而不是抛错，
 * 与「展示组件不触 store」的约束保持一致；真实应用 Root 必挂 StoreProvider，走真实值。
 *
 * 注意：selector 返回值与 defaultValue 都必须引用稳定，否则会造成无限重渲染。
 */
export function useLCodeStoreWithDefault<T>(
  selector: (state: LCodeState) => T,
  defaultValue: T,
): T {
  const store = useContext(StoreContext);
  const subscribe = useCallback(
    (onStoreChange: () => void) => (store ? store.subscribe(onStoreChange) : () => {}),
    [store],
  );
  const getSnapshot = () => (store ? selector(store.getState()) : defaultValue);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
