import { Client, Pool, type Agent, type Dispatcher } from "undici";
import type { TLSSocket } from "node:tls";

/** Undici 6 的默认 pipelining=1 限制 H2 多路复用；只有实际 ALPN 为 H2 才放开。 */
export const createNegotiatingPool: NonNullable<Agent.Options["factory"]> = (origin, options) =>
  new Pool(origin, {
    ...options,
    factory: (url, options) => {
      const clientOptions = options as Client.Options;
      const connect = clientOptions.connect;
      if (typeof connect !== "function") throw new Error("Network pool connector is missing");
      let h2 = false;
      const active = new Set<(error: Error) => void>();
      const failActive = (error: Error) => {
        if (h2) for (const abort of active) abort(error);
      };
      const singleSend: Dispatcher.DispatchInterceptor = (dispatch) => (request, handler) => {
        let sent = false;
        let abortRequest: ((error: Error) => void) | undefined;
        const overrides = {
          onConnect(abort: (error?: Error) => void) {
            // Undici 6 在 H2 GOAWAY 时只失败队首，余下 POST 会被内部重发；
            // 网络层每个 physical attempt 只能发送一次，重试必须回到 Runner 的预算与准入。
            if (sent) {
              abort(new Error("HTTP/2 request cannot be replayed inside the transport"));
              return;
            }
            sent = true;
            abortRequest = abort;
            active.add(abort);
            handler.onConnect?.(abort);
          },
          onError(error: Error) {
            if (abortRequest) active.delete(abortRequest);
            handler.onError?.(error);
          },
          onComplete(trailers: string[] | null) {
            if (abortRequest) active.delete(abortRequest);
            handler.onComplete?.(trailers);
          },
        };
        return dispatch(
          request,
          new Proxy(handler, {
            get(target, property) {
              const value = Object.hasOwn(overrides, property)
                ? overrides[property as keyof typeof overrides]
                : Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        );
      };
      const client = new (class extends Client {
        override dispatch(
          request: Dispatcher.DispatchOptions,
          handler: Dispatcher.DispatchHandlers,
        ): boolean {
          return singleSend((options, handlers) => super.dispatch(options, handlers))(
            request,
            handler,
          );
        }
      })(url, {
        ...clientOptions,
        connect: (input, callback) =>
          connect(input, (error, socket) => {
            if (error) {
              callback(error, null);
              return;
            }
            if (!socket) {
              callback(new Error("Network connector returned no socket"), null);
              return;
            }
            h2 = (socket as TLSSocket).alpnProtocol === "h2";
            client.pipelining = h2 ? 8 : 1;
            if (h2)
              socket.once("end", () => retire(new Error("HTTP/2 peer closed the connection")));
            callback(null, socket);
          }),
      });
      const retire = (error: Error) => {
        // 先退休故障 Client，防止 abort 回调触发 resume 重连；Pool 随 disconnect 移除它。
        if (h2 && !client.destroyed) void client.destroy(error).catch(() => {});
        failActive(error);
      };
      client.on("disconnect", (_origin, _targets, error) => retire(error));
      return client;
    },
  });
