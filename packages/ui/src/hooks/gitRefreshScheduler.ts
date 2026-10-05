/** 只合并 UI 的只读刷新意图，不保存 Git 或会话业务事实。 */
export function createGitRefreshScheduler<T>(options: {
  read: (extended: boolean) => Promise<T>;
  onStart: () => void;
  onResult: (result: T) => void;
  onError: (error: unknown) => void;
}) {
  let disposed = false;
  let running = false;
  let pending: boolean | null = null;

  const drain = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (pending !== null && !disposed) {
        const extended = pending;
        pending = null;
        options.onStart();
        try {
          const result = await options.read(extended);
          // 连续文件事件不能使每次成功结果都过期；先显示快照，再补读最新状态。
          if (!disposed) options.onResult(result);
        } catch (error) {
          if (!disposed) options.onError(error);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    request(extended: boolean) {
      if (disposed) return;
      pending = (pending ?? false) || extended;
      void drain();
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
