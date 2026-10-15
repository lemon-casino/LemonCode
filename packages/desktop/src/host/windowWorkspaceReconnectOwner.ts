import type { Event } from "@lcode/rpc";
import {
  WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE,
  windowWorkspaceReconnectTargetSchema,
  windowWorkspaceReconnectResultSchema,
  type WindowWorkspaceReconnectTarget,
  type WindowWorkspaceReconnectRequest,
  type WindowWorkspaceReconnectResult,
} from "@lcode/shared";

/** 只关联发往当前桌面处理者的 RPC；连接、历史和凭据继续由既有 Desktop 流程拥有。 */
export function createWindowWorkspaceReconnectOwner(createId: () => string) {
  type Owner = { token: object; listener: (request: WindowWorkspaceReconnectRequest) => void };
  type Pending = {
    owner: Owner;
    requestId: string;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
  };
  const pending = new Map<string, Pending>();
  let current: Owner | undefined;
  let disposed = false;
  const unavailable = () => new Error(WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE);
  function retire(owner: Owner) {
    if (current === owner) current = undefined;
    for (const [key, request] of pending) {
      if (request.owner !== owner) continue;
      pending.delete(key);
      request.reject(unavailable());
    }
  }
  return {
    request(raw: WindowWorkspaceReconnectTarget): Promise<void> {
      try {
        const target = windowWorkspaceReconnectTargetSchema.parse(raw);
        const owner = current;
        if (disposed || !owner) throw unavailable();
        const key = JSON.stringify([target.workspaceIdentity, target.workspacePath]);
        const existing = pending.get(key);
        if (existing) return existing.promise;
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((ok, fail) => {
          resolve = ok;
          reject = fail;
        });
        const requestId = createId();
        const request = { owner, requestId, promise, resolve, reject };
        pending.set(key, request);
        try {
          owner.listener({ ...target, requestId });
        } catch (error) {
          pending.delete(key);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return promise;
      } catch (error) {
        return Promise.reject(error);
      }
    },
    createHandler() {
      const token = {};
      let closed = false;
      const onRequest: Event<WindowWorkspaceReconnectRequest> = (listener) => {
        if (disposed || closed) throw unavailable();
        // 原因：旧 attachment 的回包不能结算新窗口处理者的重连，注册换代立即拒绝旧 RPC。
        if (current) retire(current);
        const owner = { token, listener };
        current = owner;
        return { dispose: () => retire(owner) };
      };
      return {
        onRequest,
        async complete(raw: WindowWorkspaceReconnectResult): Promise<boolean> {
          const result = windowWorkspaceReconnectResultSchema.parse(raw);
          if (closed || disposed || current?.token !== token) return false;
          for (const [key, request] of pending) {
            if (request.requestId !== result.requestId || request.owner !== current) continue;
            pending.delete(key);
            if (result.ok) request.resolve();
            else request.reject(new Error(result.error));
            return true;
          }
          return false;
        },
        dispose() {
          closed = true;
          if (current?.token === token) retire(current);
        },
      };
    },
    dispose() {
      disposed = true;
      if (current) retire(current);
    },
  };
}
export type WindowWorkspaceReconnectOwner = ReturnType<typeof createWindowWorkspaceReconnectOwner>;
