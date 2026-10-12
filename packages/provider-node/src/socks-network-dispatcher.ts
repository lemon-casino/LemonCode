import { SocksClient } from "socks";
import { connect as connectTls } from "node:tls";
import { isIP } from "node:net";
import { Agent } from "undici";

/** SOCKS5 握手与目标 TLS 属于网络 adapter，凭据只进入代理握手。 */
export function createSocksNetworkDispatcher(proxyUrl: string, ca?: string[]): Agent {
  const proxy = new URL(proxyUrl);
  return new Agent({
    connect(options, callback) {
      void SocksClient.createConnection({
        command: "connect",
        proxy: {
          host: proxy.hostname.replace(/^\[|\]$/g, ""),
          port: Number(proxy.port || 1080),
          type: 5,
          userId: decodeURIComponent(proxy.username),
          password: decodeURIComponent(proxy.password),
        },
        // 把域名交给 SOCKS5 服务端解析，避免在需要代理的本机先解析厂商域名。
        destination: {
          host: options.hostname.replace(/^\[|\]$/g, ""),
          port: Number(options.port || (options.protocol === "https:" ? 443 : 80)),
        },
      })
        .then(({ socket }) => {
          if (options.protocol !== "https:") {
            callback(null, socket);
            return;
          }
          // 使用现有 socket 时 tls 仍需要目标 host 做证书身份验证，缺省会误用 localhost。
          const secure = connectTls({
            socket,
            host: options.hostname.replace(/^\[|\]$/g, ""),
            servername:
              options.servername || (!isIP(options.hostname) ? options.hostname : undefined),
            ...(ca ? { ca } : {}),
          });
          const fail = (error: Error) => callback(error, null);
          secure.once("error", fail);
          secure.once("secureConnect", () => {
            secure.removeListener("error", fail);
            callback(null, secure);
          });
        })
        .catch((error: unknown) => {
          // 第三方握手错误可能打印整份 options；外发仅保留稳定描述，不包含 userinfo。
          callback(
            new Error("SOCKS5 proxy connection or authentication failed", { cause: error }),
            null,
          );
        });
    },
  });
}
