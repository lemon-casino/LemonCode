import http2 from "node:http2";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { createHostApiNetworkTransport, resolveHostProxyForUrl } from "../../network-transport.ts";

export function installWorkerNetwork({ scopes, check, workerData }) {
  const fetchRemote = globalThis.fetch;
  const networkTransport = createHostApiNetworkTransport(
    async () => scopes.getStore()?.network ?? {},
  );
  if (workerData.fixtureOrigin) {
    const connect = http2.connect;
    http2.connect = (_origin, ...args) => {
      if (!workerData.fixtureH2Origin)
        throw new Error("Fixture HTTP/2 transport requires a loopback endpoint");
      return connect(workerData.fixtureH2Origin, ...args);
    };
  }
  globalThis.fetch = (input, init = {}) => {
    check();
    const scope = scopes.getStore();
    const requestSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const signals = [requestSignal, scope?.controller.signal].filter(Boolean);
    let target = input;
    // Explicit fixture-only transport; production worker data never supplies it.
    if (workerData.fixtureOrigin) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const mapped = new URL(url.pathname + url.search, workerData.fixtureOrigin);
      target = input instanceof Request ? new Request(mapped, input) : mapped;
      const headers = new Headers(
        init.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set("x-fixture-upstream", url.origin);
      init = { ...init, headers };
    }
    const response = (scope?.network ? networkTransport.fetch : fetchRemote)(target, {
      ...init,
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    });
    if (scope?.listing) Object.assign(scope.listing, { tried: true, lastOk: false });
    return response.then((res) => {
      if (scope?.listing) scope.listing.lastOk = res.ok;
      return scope?.quotaFacts ? scope.quotaFacts.observe(input, res) : res;
    });
  };

  const connectHttp2 = http2.connect;
  http2.connect = (origin, options, ...args) => {
    const scope = scopes.getStore();
    const route = scope?.network
      ? resolveHostProxyForUrl(String(origin), scope.network)
      : undefined;
    if (route?.kind === "invalid") throw new Error(route.reason);
    if (route?.kind === "proxy") {
      // Cursor 已有出流前的 H1 回退；裸 H2 无代理能力时立即回退，不能偷走直连。
      const session = new EventEmitter();
      session.destroy = () => {};
      session.request = () => {
        const request = new EventEmitter();
        request.end = () => {};
        request.close = () => {};
        queueMicrotask(() =>
          session.emit(
            "error",
            Object.assign(new Error("HTTP/2 proxy transport requires HTTP/1 fallback"), {
              code: "ERR_HTTP2_ERROR",
            }),
          ),
        );
        return request;
      };
      return session;
    }
    return connectHttp2(
      origin,
      { ...options, ...(scope?.http2Ca ? { ca: scope.http2Ca } : {}) },
      ...args,
    );
  };

  return {
    dispose: () => networkTransport.dispose(),
    async prepare(scope, message) {
      if (scope.network?.caCertPath && message.operation === "fetch")
        scope.http2Ca = [...rootCertificates, await readFile(scope.network.caCertPath, "utf8")];
    },
  };
}
