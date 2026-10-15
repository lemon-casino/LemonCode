import { Client, Pool, type Agent } from "undici";
import type { TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import type { NetworkDiagnostics } from "./network-diagnostics.js";

/** Undici 8 自行按流身份结算；这里只负责故障连接的退休，不修改其请求队列。 */
export const createNegotiatingPool =
  (observe?: NetworkDiagnostics["connection"]): NonNullable<Agent.Options["factory"]> =>
  (origin, options) =>
    new Pool(origin, {
      ...options,
      factory: (url, clientOptions) => {
        const connect = (clientOptions as Client.Options).connect;
        if (typeof connect !== "function") throw new Error("Network pool connector is missing");
        let h2 = false;
        let connectionId = randomUUID();
        let ownedSocket: TLSSocket | undefined;
        const retire = (error: Error) => {
          observe?.(connectionId, h2 ? "h2" : "h1", "retired");
          if (!h2) return;
          // GOAWAY 会先从 Client 脱离 draining session；仅 destroy(Client) 关不到原 socket。
          // 保留 connector 交回的原资源，避免旧 SSE 永久等待或误关替代连接。
          ownedSocket?.destroy(error);
          if (!client.destroyed) void client.destroy(error).catch(() => {});
        };
        const client = new Client(url, {
          ...clientOptions,
          connect: (input, callback) =>
            connect(input, (error, socket) => {
              if (error || !socket) {
                callback(error ?? new Error("Network connector returned no socket"), null);
                return;
              }
              connectionId = randomUUID();
              h2 = (socket as TLSSocket).alpnProtocol === "h2";
              observe?.(connectionId, h2 ? "h2" : "h1", "connected");
              ownedSocket = socket as TLSSocket;
              if (h2)
                socket.once("end", () => retire(new Error("HTTP/2 peer closed the connection")));
              callback(null, socket);
            }),
        });
        client.on("disconnect", (_origin, _targets, error) => {
          // GOAWAY 后旧 Client 的 pending 请求不能由库内 resume 重发。
          // 先退休这个已断开的 Client，真正重试继续交给原 Runner 的预算和准入。
          retire(error);
        });
        return client;
      },
    });
