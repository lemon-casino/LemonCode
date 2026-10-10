import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { isOwnedCheckoutScope } from "../process/ownedCheckoutScope.js";
import { Emitter, Event, type Event as RpcEvent } from "@lcode/rpc";
import type { FileWatchEvent } from "@lcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** 防抖时间（ms）——批量文件变更（如 git checkout）时避免频繁刷新 */
const DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 500;

interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** 防抖定时器 */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  /** 同一防抖窗口只含一个明确路径时才透传，避免过滤掉同批次里的目标文件事件 */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
}

function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
  watch?: typeof watch;
}): IFileWatcherService & { stopPathAndWait(path: string): Promise<void> } {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchers = new Map<string, WatcherInstance>();
  const closing = new Map<string, { path: string; promise: Promise<void> }>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 watcher 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  function cleanup(id: string): Promise<void> {
    const pending = closing.get(id);
    if (pending) return pending.promise;
    const w = watchers.get(id);
    if (!w) return Promise.resolve();
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    if (w.maxWaitTimer) clearTimeout(w.maxWaitTimer);
    // close() 发起异步关闭；Windows 删除目录前必须等待实际句柄关闭，其他平台沿用相同边界。
    const closed = Promise.withResolvers<void>();
    const onClose = () => closed.resolve();
    w.watcher.once("close", onClose);
    try {
      w.watcher.close();
    } catch (error) {
      // 仅移除本次 owner 注册的等待者，保留其他观察方的原生监听。
      w.watcher.off("close", onClose);
      return Promise.reject(error);
    }
    w.changeEmitter.dispose();
    watchers.delete(id);
    const promise = closed.promise.finally(() => {
      closing.delete(id);
    });
    closing.set(id, { path: w.path, promise });
    return promise;
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        // 默认非递归监视单个目录；Git 状态这类工作区级信号会显式打开 recursive。
        fsWatcher = (options?.watch ?? watch)(
          params.path,
          { recursive },
          (_eventType, fileName) => {
            const instance = watchers.get(id);
            if (!instance) return;

            const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
            if (changedPath && !instance.hasUnknownChangedPath) {
              instance.pendingChangedPaths.add(changedPath);
              // 协议只需要“唯一明确路径”；批量上万个文件不应在合并窗口保存全部路径。
              if (instance.pendingChangedPaths.size > 1) {
                instance.hasUnknownChangedPath = true;
                instance.pendingChangedPaths.clear();
              }
            } else if (!changedPath) {
              instance.hasUnknownChangedPath = true;
              instance.pendingChangedPaths.clear();
            }

            const flush = () => {
              if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
              if (instance.maxWaitTimer) clearTimeout(instance.maxWaitTimer);
              instance.debounceTimer = instance.maxWaitTimer = null;
              const onlyChangedPath =
                !instance.hasUnknownChangedPath && instance.pendingChangedPaths.size === 1
                  ? instance.pendingChangedPaths.values().next().value
                  : undefined;
              instance.pendingChangedPaths.clear();
              instance.hasUnknownChangedPath = false;
              instance.changeEmitter.fire({
                dirPath: instance.path,
                ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
              });
            };
            // 连续写入曾不断重置尾沿 timer，Git/文件树永远收不到事件；最大等待保证批次中也广播。
            if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
            instance.debounceTimer = setTimeout(flush, DEBOUNCE_MS);
            instance.maxWaitTimer ??= setTimeout(flush, MAX_WAIT_MS);
          },
        );
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法监视目录 '${params.path}': ${message}`);
      }

      // 监视目录被删除/重命名时，发送最终事件并清理
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "文件监听器异常，清理 watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          void cleanup(id).catch(() => {});
        }
      });

      watchers.set(id, {
        path: params.path,
        watcher: fsWatcher,
        changeEmitter,
        debounceTimer: null,
        maxWaitTimer: null,
        pendingChangedPaths: new Set(),
        hasUnknownChangedPath: false,
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      await cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        void cleanup(id).catch(() => {});
      }
    },

    async stopPathAndWait(path): Promise<void> {
      const targets = [
        ...[...watchers].map(([id, instance]) => ({ id, path: instance.path })),
        ...[...closing].map(([id, instance]) => ({ id, path: instance.path })),
      ];
      const results = await Promise.allSettled(
        targets.map(async (target) => {
          if (!(await isOwnedCheckoutScope({ checkoutPath: path }, { workspacePath: target.path })))
            return;
          await cleanup(target.id);
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // watch() 成功返回后，renderer 订阅 onDynamicChange 前，底层 fs.watch
        // 仍可能因目录删除/重命名/平台 watcher 错误触发 cleanup。stale watcher id
        // 是可恢复状态，不能 throw 到 RPC 事件订阅链路导致 host 进程退出。
        log.warn(undefined, "忽略已失效的文件监听订阅", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}

/** Host 生命周期方法不能通过任意字符串 RPC 调用。 */
export function createPublicFileWatcherService(owner: IFileWatcherService): IFileWatcherService {
  return {
    watch: owner.watch.bind(owner),
    unwatch: owner.unwatch.bind(owner),
    disposeAll: owner.disposeAll.bind(owner),
    onDynamicChange: owner.onDynamicChange.bind(owner),
  };
}
