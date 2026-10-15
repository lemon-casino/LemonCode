import { NetworkCleanup } from "../../network-cleanup.ts";

/** operation 删除不等于 reader 物理关闭；复用原网络清理账本保留迟到结果。 */
export function createWorkerReaderCleanup() {
  const cleanup = new NetworkCleanup();
  return {
    cancel(scope) {
      if (!scope.reader) return;
      const reader = scope.reader;
      // 将句柄一次性交给账本；cancel message 与 operation finally 不重复取消已释放 reader。
      scope.reader = undefined;
      cleanup.retain(reader, async () => {
        try {
          await reader.cancel(scope.controller.signal.reason);
        } catch (error) {
          if (!scope.controller.signal.aborted || error !== scope.controller.signal.reason)
            throw error;
        }
      });
    },
    drain: () => cleanup.drain(),
  };
}
