import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { isNetworkProxyUrl, normalizeNetworkProxyUrl } from "@lcode/shared/network-proxy";
import { createSocksNetworkDispatcher } from "./socks-network-dispatcher.js";
import { createNegotiatingPool } from "./network-http2-client.js";
import { createNetworkRequestLease, waitForNetworkResult } from "./network-request-lifecycle.js";
import { NetworkCleanup } from "./network-cleanup.js";
import { NetworkDiagnostics } from "./network-diagnostics.js";

export interface HostApiNetworkOptions {
  http2?: "disabled" | "negotiate";
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
  forceDirect?: boolean;
  /** CLI 既有 HTTP 目标走 forward proxy；Host 兼容入口默认保留 CONNECT。 */
  proxyTunnel?: boolean;
}

export interface HostApiNetworkTransport {
  fetch: typeof fetch;
  readonly activeRequestCount: number;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

type HostProxyRoute =
  | { kind: "direct"; noProxyMatched?: boolean }
  | { kind: "proxy"; proxyUrl: string }
  | { kind: "invalid"; reason: string };

function mergeHostApiCaCertificates(
  customCa: string,
  defaultCa: readonly string[] = rootCertificates,
): string[] {
  // Node 的 tls.ca 会替换而不是追加默认根证书。只传企业代理 CA 会让未被
  // 中间人重签的公网证书失去信任链，因此必须同时保留 Node 默认根证书。
  return [...defaultCa, customCa];
}

function normalizeProxyUrl(value: string): string | undefined {
  const candidate = /^\w[\w+.-]*:\/\//.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (!isNetworkProxyUrl(url.href)) {
      return undefined;
    }
    return normalizeNetworkProxyUrl(url.href);
  } catch {
    return undefined;
  }
}

function matchesNoProxy(url: URL, value: string | undefined): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (value ?? "").split(/[\s,]+/).some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;

    const ruleWithoutScheme = rule.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
    const [ruleHost = "", rulePort] = ruleWithoutScheme.split(":");
    const normalizedHost = ruleHost.replace(/^\*\.?/, "").replace(/^\./, "");
    if (!normalizedHost) return false;
    const hostMatches = host === normalizedHost || host.endsWith(`.${normalizedHost}`);
    return hostMatches && (!rulePort || rulePort === port);
  });
}

export function resolveHostProxyForUrl(
  requestUrl: string | URL,
  options: HostApiNetworkOptions,
): HostProxyRoute {
  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return { kind: "direct" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "direct" };
  }
  if (matchesNoProxy(url, options.noProxy)) {
    return { kind: "direct", noProxyMatched: true };
  }
  const configuredProxy = options.httpProxy?.trim();
  if (!configuredProxy) {
    return { kind: "direct" };
  }
  const proxyUrl = normalizeProxyUrl(configuredProxy);
  return proxyUrl
    ? { kind: "proxy", proxyUrl }
    : { kind: "invalid", reason: "Configured Host proxy URL is invalid" };
}

interface HostApiNetworkTransportDependencies {
  onIdle?: () => void;
  /** 终端 IO 注入仍经过策略解析/验证，不因 direct 而改走真实网络。 */
  fetch?: typeof globalThis.fetch;
  createDispatcher?: typeof createDispatcher;
  fetchWithDispatcher?: (
    input: string,
    init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher; duplex?: "half" },
  ) => Promise<Response>;
}

export function createHostApiNetworkTransport(
  resolveOptions: () => Promise<HostApiNetworkOptions>,
  dependencies: HostApiNetworkTransportDependencies = {},
): HostApiNetworkTransport {
  // Host 是独立 Node 进程，Electron Session.setProxy 不会影响它的 globalThis.fetch；
  // 在 NodeApiClient 出口按请求注入 dispatcher，避免把 telemetry 等其它裸 fetch 全局改道。
  const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
  const readyDispatchers = new Set<string>();
  const dispatcherRequests = new Map<string, number>();
  // Node Request 内部取消 controller 是弱引用；只保存 signal 会在长 SSE 的 GC 后丢失取消。
  const requests = new Map<
    AbortController,
    { request: Request; source: Parameters<typeof globalThis.fetch>[0] }
  >();
  let disposed = false;
  let generation = 0;
  let pendingDispatcherCreations = 0;
  let resolveDispatcherCreations: (() => void) | undefined;
  let dispatcherCreationsDone: Promise<void> | undefined;
  const cleanup = new NetworkCleanup();
  const diagnostics = new NetworkDiagnostics();
  let disposePromise: Promise<void> | undefined;
  let disposeMode: "close" | "destroy" | undefined;
  const dispatcherFactory = dependencies.createDispatcher ?? createDispatcher;
  const fetchWithDispatcher =
    dependencies.fetchWithDispatcher ??
    ((input, init) => {
      if (dependencies.fetch) {
        const { dispatcher: _dispatcher, ...requestInit } = init;
        return dependencies.fetch(new Request(input, requestInit));
      }
      return undiciFetch(input, init as never) as unknown as Promise<Response>;
    });

  const retireDispatcher = (pending: Promise<Dispatcher>, mode: "close" | "destroy") =>
    cleanup.retain(pending, async () => {
      const dispatcher = await pending.catch(() => undefined);
      if (dispatcher) await dispatcher[mode]();
    });
  const trimIdleDispatchers = () => {
    if (disposed) return;
    let idle = 0;
    for (const key of readyDispatchers) if (!dispatcherRequests.has(key)) idle++;
    for (const [key, pending] of dispatcherPromises) {
      if (idle <= 32) break;
      if (!readyDispatchers.has(key) || dispatcherRequests.has(key)) continue;
      dispatcherPromises.delete(key);
      readyDispatchers.delete(key);
      idle--;
      retireDispatcher(pending, "close");
    }
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (disposed) {
      throw new DOMException("Host API network transport has been disposed", "AbortError");
    }
    const request = new Request(input as Parameters<typeof globalThis.fetch>[0], init);
    request.signal.throwIfAborted();
    let leasedDispatcherKey: string | undefined;
    const lease = createNetworkRequestLease(
      request.signal,
      () => {
        requests.delete(lease.controller);
        diagnostics.finish();
        if (leasedDispatcherKey) {
          const remaining = (dispatcherRequests.get(leasedDispatcherKey) ?? 1) - 1;
          if (remaining) dispatcherRequests.set(leasedDispatcherKey, remaining);
          else dispatcherRequests.delete(leasedDispatcherKey);
        }
        trimIdleDispatchers();
        if (requests.size === 0) dependencies.onIdle?.();
      },
      (key, run) => cleanup.retain(key, run),
    );
    requests.set(lease.controller, { request, source: input });
    diagnostics.start();
    try {
      const requestGeneration = generation;
      const options = await waitForNetworkResult(resolveOptions(), lease.controller.signal);
      if (disposed || generation !== requestGeneration) {
        throw new DOMException("Host API network transport has been disposed", "AbortError");
      }
      const requestUrl = request.url;
      const route = resolveHostProxyForUrl(requestUrl, options);
      if (route.kind === "invalid") {
        throw new Error(route.reason);
      }
      // 直连也必须由当前 owner 持有 dispatcher；不能漏回全局 fetch 的连接/关闭路径。

      const dispatcherKey = `${route.kind}:${route.kind === "proxy" ? route.proxyUrl : "direct"}:${options.caCertPath ?? ""}:${options.proxyTunnel !== false}:${options.http2 ?? "disabled"}`;
      leasedDispatcherKey = dispatcherKey;
      dispatcherRequests.set(dispatcherKey, (dispatcherRequests.get(dispatcherKey) ?? 0) + 1);
      let dispatcherPromise = dispatcherPromises.get(dispatcherKey);
      if (dispatcherPromise) {
        dispatcherPromises.delete(dispatcherKey);
        dispatcherPromises.set(dispatcherKey, dispatcherPromise);
      }
      if (!dispatcherPromise) {
        if (disposed) {
          throw new DOMException("Host API network transport has been disposed", "AbortError");
        }
        const dispatcherGeneration = generation;
        pendingDispatcherCreations += 1;
        dispatcherPromise = dispatcherFactory(
          route,
          options.caCertPath,
          options.proxyTunnel,
          options.http2,
          diagnostics.connection,
        );
        dispatcherPromises.set(dispatcherKey, dispatcherPromise);
        void dispatcherPromise
          .then(() => {
            if (
              (disposed || generation !== dispatcherGeneration) &&
              dispatcherPromises.get(dispatcherKey) === dispatcherPromise
            ) {
              dispatcherPromises.delete(dispatcherKey);
              retireDispatcher(dispatcherPromise!, disposeMode ?? "destroy");
            } else if (!disposed) {
              readyDispatchers.add(dispatcherKey);
              trimIdleDispatchers();
            }
          })
          .catch(() => {});
        const markDispatcherCreationDone = () => {
          pendingDispatcherCreations -= 1;
          if (pendingDispatcherCreations === 0) {
            resolveDispatcherCreations?.();
            resolveDispatcherCreations = undefined;
          }
        };
        void dispatcherPromise.then(markDispatcherCreationDone, markDispatcherCreationDone);
        dispatcherPromise.catch(() => {
          // 设置/CA 等临时 IO 失败只影响当前请求；清理 rejected dispatcher，避免一次启动竞态
          // 把同一路由永久锁死，同时仍保持失败请求 fail-closed、不回退到直连。
          if (dispatcherPromises.get(dispatcherKey) === dispatcherPromise) {
            dispatcherPromises.delete(dispatcherKey);
          }
        });
      }
      const dispatcher = await waitForNetworkResult(dispatcherPromise, lease.controller.signal);
      if (disposed || generation !== requestGeneration) {
        throw new DOMException("Host API network transport has been disposed", "AbortError");
      }
      // Node 内置 fetch 的 Request 与独立 undici 包不是同一构造器；OAuth driver
      // 使用 Request 输入时必须投影公共字段，否则代理分支会把它当成 URL 文本。
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
      lease.controller.signal.throwIfAborted();
      // Buffer/Blob 会被 H2 backend 在 REFUSED_STREAM/GOAWAY 时自动重放，即使是 POST。
      // 使用公开的单次流 body 保留每次 physical attempt 的边界；重试仍由 Runner 准入。
      const singleUse = options.http2 === "negotiate" && !["GET", "HEAD"].includes(request.method);
      const wireBody = singleUse
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              if (body) controller.enqueue(body);
              controller.close();
            },
          })
        : body;
      const pendingResponse = fetchWithDispatcher(request.url, {
        ...init,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: wireBody,
        ...(singleUse ? { duplex: "half" as const } : {}),
        signal: lease.controller.signal,
        redirect: request.redirect,
        dispatcher,
      });
      cleanup.retain(pendingResponse, async () => {
        await pendingResponse.catch(() => {});
      });
      const response = await waitForNetworkResult(
        pendingResponse,
        lease.controller.signal,
        (late) => {
          if (late.body) cleanup.retain(late, () => late.body!.cancel());
        },
      );
      return lease.response(response);
    } catch (error) {
      lease.controller.abort(error);
      lease.finish();
      throw error;
    }
  };

  const startDispose = (mode: "close" | "destroy"): Promise<void> => {
    if (disposePromise) return disposePromise;
    cleanup.retryFailed();
    diagnostics.phase("closing");
    disposed = true;
    generation += 1;
    disposeMode = mode;
    // 等待式退出同样必须先取消长 SSE；close() 本身会无限等待尚未结束的 body。
    for (const controller of requests.keys())
      controller.abort(
        new DOMException("Host API network transport has been disposed", "AbortError"),
      );
    // dispatcher 不能只被闭包缓存、没有 Host owner：窗口/远端 Host 重建后连接池和
    // keep-alive socket 仍可能存活。释放时对当前单飞 Promise 做快照，确保初始化中的 dispatcher
    // 也会在完成后被收口；同步退出 destroy，等待式退出 close。
    const pendingDispatchers = [...dispatcherPromises.values()];
    dispatcherPromises.clear();
    readyDispatchers.clear();
    if (pendingDispatcherCreations > 0) {
      dispatcherCreationsDone = new Promise<void>((resolve) => {
        resolveDispatcherCreations = resolve;
      });
    }
    disposePromise = (async () => {
      for (const pending of pendingDispatchers) retireDispatcher(pending, mode);
      await dispatcherCreationsDone;
      await cleanup.drain();
      diagnostics.phase("closed");
    })();
    // 失败保留原资源；下一次关闭只重试未完成的清理，不重新接受业务请求。
    void disposePromise.catch(() => {
      diagnostics.phase("failed");
      disposePromise = undefined;
    });
    return disposePromise;
  };

  return {
    fetch,
    get activeRequestCount() {
      return requests.size;
    },
    dispose() {
      void startDispose("destroy").catch(() => {});
    },
    disposeAndWait() {
      return startDispose("close");
    },
  };
}

async function createDispatcher(
  route: Exclude<HostProxyRoute, { kind: "invalid" }>,
  caCertPath: string | undefined,
  proxyTunnel?: boolean,
  http2?: "disabled" | "negotiate",
  observe?: NetworkDiagnostics["connection"],
): Promise<Dispatcher> {
  const allowH2 = http2 === "negotiate";
  const customCa = caCertPath ? await readFile(caCertPath, "utf8") : undefined;
  const ca = customCa ? mergeHostApiCaCertificates(customCa) : undefined;
  if (route.kind === "proxy") {
    const url = new URL(route.proxyUrl);
    if (url.protocol === "socks5:")
      return createSocksNetworkDispatcher(route.proxyUrl, ca, allowH2, observe);
    return new ProxyAgent({
      allowH2,
      h2Options: { maxConcurrentStreams: 8 },
      ...(allowH2 ? { factory: createNegotiatingPool(observe) } : {}),
      connections: 8,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
      headersTimeout: 600_000,
      bodyTimeout: 0,
      // Undici 8 的 HTTP 默认改为 forward；Host 既有 CONNECT 契约必须显式保留。
      proxyTunnel: proxyTunnel !== false,
      uri: route.proxyUrl,
      ...(url.username || url.password
        ? {
            token: `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`,
          }
        : {}),
      proxyTls: { ...(ca ? { ca } : {}), allowH2: false },
      // 隧道内目标 connector 不继承 allowH2，必须单独设置 ALPN。
      requestTls: { ...(ca ? { ca } : {}), allowH2 },
    });
  }
  return new Agent({
    allowH2,
    h2Options: { maxConcurrentStreams: 8 },
    ...(allowH2 ? { factory: createNegotiatingPool(observe) } : {}),
    connections: 8,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    headersTimeout: 600_000,
    bodyTimeout: 0,
    connect: ca ? { ca } : undefined,
  });
}
