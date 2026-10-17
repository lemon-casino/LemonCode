import { request as requestHttp, type ClientRequest } from "node:http";
import { request as requestHttps } from "node:https";
import { connect, isIP, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { SocksClient } from "socks";
import { isNetworkProxyUrl, normalizeNetworkProxyUrl } from "@lcode/shared/network-proxy";

export interface NetworkProxySocketOptions {
  proxyUrl: string;
  host: string;
  port: number;
  caCertPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_PROXY_TIMEOUT_MS = 60_000;

/** 返回暂停读取的隧道；调用者安装协议监听后 resume，并拥有后续 destroy。 */
export async function connectNetworkProxySocket(
  options: NetworkProxySocketOptions,
): Promise<Socket> {
  if (!isNetworkProxyUrl(options.proxyUrl)) throw new Error("代理地址无效，请检查设置中的代理配置");
  const proxy = new URL(normalizeNetworkProxyUrl(options.proxyUrl));
  const controller = new AbortController();
  let socket: Socket | undefined;
  let request: ClientRequest | undefined;
  let timedOut = false;
  const abort = () => controller.abort();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  const destroy = () => {
    request?.destroy();
    socket?.destroy();
  };
  controller.signal.addEventListener("abort", destroy, { once: true });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
    if (proxy.protocol === "socks5:") {
      // 先持有 TCP socket，取消时可立即终止 SOCKS 握手，不等待第三方内部超时。
      socket = connect({ host: proxyHost, port: Number(proxy.port || 1080) });
      socket.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        socket!.once("connect", resolve);
        socket!.once("error", reject);
        socket!.once("close", () => reject(new Error("Proxy socket closed")));
      });
      controller.signal.throwIfAborted();
      await SocksClient.createConnection({
        command: "connect",
        existing_socket: socket,
        timeout: timeoutMs,
        proxy: {
          host: proxyHost,
          port: Number(proxy.port || 1080),
          type: 5,
          userId: decodeURIComponent(proxy.username),
          password: decodeURIComponent(proxy.password),
        },
        destination: { host: options.host.replace(/^\[|\]$/g, ""), port: options.port },
      });
    } else {
      const customCa =
        proxy.protocol === "https:" && options.caCertPath
          ? await readFile(options.caCertPath, { encoding: "utf8", signal: controller.signal })
          : undefined;
      controller.signal.throwIfAborted();
      const host = options.host.replace(/^\[|\]$/g, "");
      const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${options.port}`;
      socket = await new Promise<Socket>((resolve, reject) => {
        request = (proxy.protocol === "https:" ? requestHttps : requestHttp)({
          hostname: proxyHost,
          // HTTPS 默认可能从 CONNECT 的目标 Host 头推导 TLS 身份；必须验证代理自身，
          // 否则合法代理证书会被拿去匹配 SSH 目标域名。IP 代理不发送 SNI。
          ...(proxy.protocol === "https:" ? { servername: isIP(proxyHost) ? "" : proxyHost } : {}),
          port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
          method: "CONNECT",
          path: authority,
          agent: false,
          signal: controller.signal,
          ...(customCa ? { ca: [...rootCertificates, customCa] } : {}),
          headers: {
            Host: authority,
            ...(proxy.username || proxy.password
              ? {
                  "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
                }
              : {}),
          },
        });
        request.on("error", reject);
        request.once("close", () => reject(new Error("Proxy request closed")));
        request.once("connect", (response, connected, head) => {
          connected.on("error", () => {});
          if (controller.signal.aborted || response.statusCode !== 200) {
            connected.destroy();
            reject(new Error("Proxy CONNECT failed"));
            return;
          }
          connected.pause();
          // 代理可把 SSH banner 与 CONNECT 响应一起返回，必须交还给 ssh2，不能吞掉首帧。
          if (head.length) connected.unshift(head);
          resolve(connected);
        });
        request.end();
      });
    }
    controller.signal.throwIfAborted();
    socket.pause();
    return socket;
  } catch {
    destroy();
    // 第三方 SOCKS/HTTP 错误可能携带整份 options 和 userinfo；不向日志传递原 cause。
    throw new Error(
      options.signal?.aborted
        ? "SSH 代理连接已取消"
        : timedOut
          ? "SSH 代理连接超时"
          : "SSH 代理连接或认证失败，请检查设置中的代理配置",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", destroy);
  }
}
