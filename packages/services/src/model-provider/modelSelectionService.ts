import type {
  ModelSelectionFacade,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@lcode/provider";
import type {
  IModelSelectionService,
  ModelSelectionConfiguredDefaultSource,
} from "./providerFacadeServices.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

export function createModelSelectionService(
  facade: ModelSelectionFacade,
  ensureReady: () => Promise<void> = async () => {},
  configuredDefaultSource?: ModelSelectionConfiguredDefaultSource,
): IModelSelectionService & { dispose(): void } {
  const log = createServiceLogger("model-selection");
  let revision = 0;
  let disposed = false;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    await ensureReady();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const configuredDefault = await configuredDefaultSource?.read();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const base = facade.getView(configuredDefault);
    if (revision < base.revision) revision = base.revision;
    return facade.getView(configuredDefault, revision, input);
  };
  const emit = (): void => {
    if (disposed) return;
    revision += 1;
    void getView().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        // Registry 事件触发的异步 View 重建没有 owner；Host dispose 后它仍会继续
        // 读取已释放的配置仓库，并形成未处理 rejection。dispose 是明确的取消边界；仅在服务
        // 仍存活时记录真实读取失败。
        if (disposed) return;
        log.warn(undefined, `ModelSelection View 刷新失败: ${String(error)}`);
      },
    );
  };
  const disposeFacade = facade.onDidChange(emit);
  const disposeConfiguredDefault = configuredDefaultSource?.onDidChange?.(emit);

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getView,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeFacade();
      disposeConfiguredDefault?.();
      listeners.clear();
    },
  };
}
