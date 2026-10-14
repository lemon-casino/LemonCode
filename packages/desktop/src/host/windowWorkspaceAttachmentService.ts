import { Emitter, type Event, type IServerChannel } from "@lcode/rpc";
import {
  ServiceChannels,
  windowWorkspaceCatalogSchema,
  windowWorkspaceRpcCallSchema,
  windowWorkspaceRpcListenSchema,
  type WindowWorkspaceCatalogEntry,
  type WindowWorkspaceScope,
} from "@lcode/shared";
import type { IWindowWorkspaceService } from "@lcode/services";

export interface WorkspaceAttachmentChannels {
  channels: ReadonlyMap<string, IServerChannel>;
  dispose(): void;
  setTransportFlowState(state: "saturated" | "drained" | "closed"): Promise<void>;
}

/** 每设备只持有服务/协议 carrier，连接、会话和运行时仍由窗口 Host 所有。 */
export function createWindowWorkspaceAttachmentService<T>(options: {
  getCatalog(): WindowWorkspaceCatalogEntry[];
  onCatalogChanged: Event<void>;
  resolveScope(scope: WindowWorkspaceScope): T;
  createChannels(scope: WindowWorkspaceScope, source: T): WorkspaceAttachmentChannels;
}) {
  const routes = new Map<
    string,
    {
      scope: WindowWorkspaceScope;
      source: T;
      handle: WorkspaceAttachmentChannels;
      ready: Promise<void>;
    }
  >();
  const catalogEmitter = new Emitter<WindowWorkspaceCatalogEntry[]>();
  const listeners = new Set<{ scope: WindowWorkspaceScope; dispose(): void }>();
  const allowedChannels = new Set<string>(Object.values(ServiceChannels));
  let disposed = false;
  let transportState: "saturated" | "drained" | "closed" = "drained";
  const keyOf = (scope: WindowWorkspaceScope) => JSON.stringify(scope);
  function check(scope: WindowWorkspaceScope, source?: T) {
    if (disposed) throw new Error("workspace attachment 已释放");
    const current = options.resolveScope(scope);
    if (source !== undefined && current !== source)
      throw new Error("workspace attachment source 已换代");
    return current;
  }
  function route(scope: WindowWorkspaceScope, channelName: string) {
    // 只复用公开服务面；内部 provider target、再路由等 channel 不能由客户端指定。
    if (!allowedChannels.has(channelName) || channelName === ServiceChannels.WindowController)
      throw new Error("workspace channel 不属于公开 scoped 服务");
    const source = check(scope);
    const key = keyOf(scope);
    let value = routes.get(key);
    if (!value) {
      const handle = options.createChannels(scope, source);
      const ready =
        transportState === "drained"
          ? Promise.resolve()
          : handle.setTransportFlowState(transportState);
      value = { scope, source, handle, ready };
      routes.set(key, value);
    }
    check(scope, value.source);
    const channel = value.handle.channels.get(channelName);
    if (!channel) throw new Error(`workspace service unavailable: ${channelName}`);
    return { ...value, channel };
  }
  const catalogSubscription = options.onCatalogChanged(() => {
    for (const [key, value] of routes) {
      try {
        check(value.scope, value.source);
      } catch {
        value.handle.dispose();
        routes.delete(key);
      }
    }
    for (const listener of listeners) {
      try {
        check(listener.scope);
      } catch {
        listener.dispose();
      }
    }
    if (!disposed) catalogEmitter.fire(windowWorkspaceCatalogSchema.parse(options.getCatalog()));
  });
  const service: IWindowWorkspaceService = {
    async getCatalog() {
      if (disposed) throw new Error("workspace attachment 已释放");
      return windowWorkspaceCatalogSchema.parse(options.getCatalog());
    },
    onDidChangeCatalog: catalogEmitter.event,
    async call(raw) {
      const params = windowWorkspaceRpcCallSchema.parse(raw);
      const value = route(params.scope, params.channel);
      await value.ready;
      check(params.scope, value.source);
      const result = await value.channel.call("workspace", params.command, params.args);
      // 异步读取返回时再次验证，旧 session/generation 的回包不能写入新页面。
      check(params.scope, value.source);
      return result;
    },
    onDynamicScopedEvent(raw) {
      const params = windowWorkspaceRpcListenSchema.parse(raw);
      return (listener) => {
        const value = route(params.scope, params.channel);
        const subscription = value.channel.listen(
          "workspace",
          params.event,
          params.arg,
        )((event) => {
          try {
            check(params.scope, value.source);
          } catch {
            return;
          }
          listener(event);
        });
        const handle = {
          scope: params.scope,
          dispose() {
            subscription.dispose();
            listeners.delete(handle);
          },
        };
        listeners.add(handle);
        return handle;
      };
    },
  };
  return {
    service,
    async setTransportFlowState(state: "saturated" | "drained" | "closed") {
      if (disposed) return;
      transportState = state;
      await Promise.all(
        [...routes.values()].map((route) => route.handle.setTransportFlowState(state)),
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      catalogSubscription.dispose();
      for (const listener of listeners) listener.dispose();
      for (const route of routes.values()) route.handle.dispose();
      routes.clear();
      catalogEmitter.dispose();
    },
  };
}
