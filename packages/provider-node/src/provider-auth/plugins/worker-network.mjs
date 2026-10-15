import http2 from "node:http2";
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { createHostApiNetworkTransport, resolveHostProxyForUrl } from "../../network-transport.ts";

export function installWorkerNetwork({ scopes, check, workerData, refresh }) {
  const fetchRemote = globalThis.fetch;
  const managedFetch = new AsyncLocalStorage();
  const sessions = new Map();
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
  globalThis.fetch = async (input, init = {}) => {
    check();
    const scope = scopes.getStore();
    const rotationSignal = await refresh?.before(input, init);
    check();
    const requestSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const signals = [
      requestSignal === scope?.controller.signal && rotationSignal ? undefined : requestSignal,
      rotationSignal ?? scope?.controller.signal,
    ].filter(Boolean);
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
    const response = managedFetch.run(true, () =>
      (scope?.network ? networkTransport.fetch : fetchRemote)(target, {
        ...init,
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      }),
    );
    if (scope?.listing) Object.assign(scope.listing, { tried: true, lastOk: false });
    return response.then((res) => {
      if (scope?.listing) scope.listing.lastOk = res.ok;
      if (scope?.catalogFacts) res = scope.catalogFacts.observe(input, res);
      return scope?.quotaFacts ? scope.quotaFacts.observe(input, res) : res;
    });
  };

  const connectHttp2 = http2.connect;
  http2.connect = (origin, options, ...args) => {
    const scope = scopes.getStore();
    check();
    // 轮换交接只允许受控 fetch，裸 H2 仍属于原业务取消域。
    if (!managedFetch.getStore()) scope?.controller.signal.throwIfAborted();
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
    const session = connectHttp2(
      origin,
      { ...options, ...(scope?.http2Ca ? { ca: scope.http2Ca } : {}) },
      ...args,
    );
    // 裸 H2（Cursor）按 operation 持有 session；通用池由 transport 管理，不能随单流取消。
    if (!managedFetch.getStore()) {
      const signal = scope?.controller.signal;
      const abort = () => session.destroy(signal.reason);
      const done = new Promise((resolve) =>
        session.once("close", () => {
          signal?.removeEventListener("abort", abort);
          sessions.delete(session);
          resolve();
        }),
      );
      sessions.set(session, done);
      session.on("error", () => {});
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }
    return session;
  };

  return {
    dispose: () => networkTransport.dispose(),
    async disposeAndWait() {
      const closing = [...sessions.entries()];
      for (const [session] of closing) session.destroy();
      await Promise.all([networkTransport.disposeAndWait(), ...closing.map(([, done]) => done)]);
    },
    async prepare(scope, message) {
      if (scope.network?.caCertPath && message.operation === "fetch")
        scope.http2Ca = [...rootCertificates, await readFile(scope.network.caCertPath, "utf8")];
    },
  };
}
