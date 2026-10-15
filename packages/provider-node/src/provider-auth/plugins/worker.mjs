import { parentPort, workerData } from "node:worker_threads";
import { AsyncLocalStorage } from "node:async_hooks";
import { createQuotaFacts } from "./quota-facts.mjs";
import childProcess from "node:child_process";
import http from "node:http";
import { plugins, assertGrantChannel } from "./catalog.mjs";
import { authorize, grantFrom, methodsFor, modelList } from "./compatibility.mjs";
import { factoryImports } from "./factory-import.mjs";
import { resolveZCodeLocal, zcodeLocalChallenge } from "./zcode-local.mjs";
import { installWorkerNetwork } from "./worker-network.mjs";
import { fetchPluginModel } from "./worker-fetch.mjs";
import { createWorkerReaderCleanup } from "./worker-reader-cleanup.mjs";
import { createWorkerRefresh } from "./worker-refresh.mjs";
import { createWorkerCredentials } from "./worker-credentials.mjs";

const scopes = new AsyncLocalStorage();
const operations = new Map();
const callbacks = new Map();
const children = new Set();
const servers = new Set();
const readerCleanup = createWorkerReaderCleanup();
let sequence = 0;
let closed = false;
let refreshTail = Promise.resolve();
let listing;
let discovered;
const localFixture =
  workerData.fixtureOrigin && workerData.fixtureLocalHome
    ? { home: workerData.fixtureLocalHome, seed: "fixture-secret" }
    : undefined;
const send = (message) => parentPort.postMessage(message);
const check = () => {
  if (closed) throw new Error("Plugin driver disposed");
  const scope = scopes.getStore();
  (scope?.rotation?.signal ?? scope?.controller.signal)?.throwIfAborted();
};
const failure = (error) => ({
  name: error?.name || "Error",
  message: error?.message || String(error),
  ...(error?.signIn ? { signIn: error.signIn } : {}),
});

// Each account runs in a disposable worker. Track vendor-owned callback servers
// and CLI children so cancellation cannot leave a login process running.
for (const method of ["spawn", "execFile"]) {
  const original = childProcess[method];
  childProcess[method] = (...args) => {
    check();
    scopes.getStore()?.controller.signal.throwIfAborted();
    const network = scopes.getStore()?.network;
    if (network) {
      const index = Array.isArray(args[1]) ? 2 : 1;
      const originalOptions = args[index] && typeof args[index] === "object" ? args[index] : {};
      const env = {
        ...process.env,
        ...originalOptions.env,
        HTTP_PROXY: network.httpProxy ?? "",
        HTTPS_PROXY: network.httpProxy ?? "",
        ALL_PROXY: "",
        http_proxy: network.httpProxy ?? "",
        https_proxy: network.httpProxy ?? "",
        all_proxy: "",
        NO_PROXY: network.noProxy ?? "",
        no_proxy: network.noProxy ?? "",
        ...(network.caCertPath ? { NODE_EXTRA_CA_CERTS: network.caCertPath } : {}),
      };
      // 插件的 CLI 授权同样属于选中供应商出口；不能继承 Host 的另一代理。
      if (args[index] && typeof args[index] !== "object") args.splice(index, 0, { env });
      else args[index] = { ...originalOptions, env };
    }
    const child = original(...args);
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };
}
const createServer = http.createServer;
http.createServer = (...args) => {
  check();
  scopes.getStore()?.controller.signal.throwIfAborted();
  const server = createServer(...args);
  servers.add(server);
  server.once("close", () => servers.delete(server));
  return server;
};
const credentials = createWorkerCredentials({
  scopes,
  check,
  send,
  committed: (scope) => workerRefresh.committed(scope),
});
const credential = (action, grant) => credentials.call(action, grant);
const workerRefresh = createWorkerRefresh({
  channel: workerData.channel,
  scopes,
  credential,
  send,
});
const networkTransport = installWorkerNetwork({
  scopes,
  check,
  workerData,
  refresh: workerRefresh,
});

const hooksPromise = (async () => {
  const create = plugins[workerData.channel];
  if (!create) throw new Error("Unsupported plugin channel");
  const client = {
    auth: {
      set: async ({ path, body }) => {
        const hooks = await hooksPromise;
        if (path?.id !== hooks.auth.provider)
          throw new Error("Plugin attempted another provider's credential write");
        assertGrantChannel(workerData.channel, body);
        await credential("write", body);
      },
    },
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    config: { get: async () => ({ data: {} }) },
  };
  return create({ client, directory: "", worktree: "", serverUrl: new URL("http://127.0.0.1") });
})();

async function providerOf(hooks) {
  if (!listing) {
    const config = { provider: {} };
    await hooks.config?.(config);
    const source = config.provider[hooks.auth.provider];
    if (!source) throw new Error("Plugin gave no provider configuration");
    listing = {
      ...source,
      id: hooks.auth.provider,
      models: Object.fromEntries(
        Object.entries(source.models ?? {}).map(([id, m]) => [
          id,
          { ...m, id, providerID: hooks.auth.provider },
        ]),
      ),
    };
  }
  return listing;
}

async function currentGrant() {
  const grant = await resolveZCodeLocal(workerData.channel, await credential("read"), localFixture);
  check();
  if (!grant) throw new Error("Provider account is not connected");
  assertGrantChannel(workerData.channel, grant);
  return grant;
}

async function fresh(hooks) {
  const grant = await currentGrant();
  if (
    !hooks.auth.refresh ||
    grant.type !== "oauth" ||
    !(grant.expires > 0) ||
    grant.expires > Date.now() + (hooks.auth.refreshLead ?? 60_000)
  )
    return;
  // 每个排队刷新保留自己的取消域；共享第一个请求的 Promise 会把取消
  // 传播给同账号的其他会话。获得锁后重读凭据，避免重复消费轮换 token。
  const run = refreshTail.then(async () => {
    check();
    const current = await currentGrant();
    if (
      current.type !== "oauth" ||
      !(current.expires > 0) ||
      current.expires > Date.now() + (hooks.auth.refreshLead ?? 60_000)
    )
      return;
    const changes = await hooks.auth.refresh(current, hooks.auth.provider);
    check();
    if (changes) {
      await credential("write", { ...(await currentGrant()), ...changes });
      await credential("signin", "renewed");
    }
  });
  refreshTail = run.catch(() => {});
  await run;
  check();
}

async function call(message, scope) {
  const hooks = await hooksPromise;
  check();
  if (message.operation === "methods") return methodsFor(hooks, workerData.channel);
  if (message.operation === "authorize") {
    const challenge =
      workerData.channel === "factory" && message.methodId === "import-files"
        ? {
            method: "auto",
            completeMany: () =>
              factoryImports(message.inputs.files, { signal: scope.controller.signal }),
          }
        : ["zai", "bigmodel"].includes(workerData.channel) && message.methodId === "2"
          ? zcodeLocalChallenge(workerData.channel, localFixture)
          : await authorize(hooks, workerData.channel, message.methodId, message.inputs);
    check();
    if (typeof challenge?.callback !== "function" && typeof challenge?.completeMany !== "function")
      throw new Error("Provider gave no authorization callback");
    const challengeId = ++sequence;
    callbacks.set(challengeId, challenge);
    return {
      challengeId,
      url: challenge.url,
      instructions: challenge.instructions,
      method: challenge.method || "auto",
      batch: typeof challenge.completeMany === "function",
    };
  }
  if (message.operation === "complete" || message.operation === "completeMany") {
    const challenge = callbacks.get(message.challengeId);
    if (!challenge) throw new Error("Authorization attempt no longer exists");
    callbacks.delete(message.challengeId);
    if (message.operation === "completeMany") {
      if (!challenge.completeMany) throw new Error("This method does not support batch import");
      const entries = await challenge.completeMany();
      check();
      return entries;
    }
    const result = grantFrom(await challenge.callback(message.code));
    check();
    assertGrantChannel(workerData.channel, result);
    return result;
  }
  await fresh(hooks);
  const provider = await providerOf(hooks);
  if (message.operation === "quota") {
    // Zen Free 的 hook 只返回静态套餐名称，没有额度接口；不能把它当作尚未获取。
    if (workerData.channel === "opencode-zen-free" || !hooks.auth.usage)
      return { status: "unsupported" };
    scope.quotaFacts = createQuotaFacts(workerData.channel, scope.controller.signal);
    const result = await hooks.auth.usage(currentGrant, provider);
    if (["expired", "kept", "renewed"].includes(result?.signIn))
      await credential("signin", result.signIn);
    return scope.quotaFacts ? scope.quotaFacts.apply(result) : result;
  }
  const loader = await hooks.auth.loader(currentGrant, provider);
  check();
  if (message.operation === "models" || message.operation === "modelCatalog") {
    scope.listing = { tried: false, lastOk: false };
    const models = hooks.provider?.models
      ? await hooks.provider.models(provider, { auth: await currentGrant() })
      : provider.models;
    check();
    const fallback =
      models?.[Symbol.for("magpie.fellBack")] === true ||
      (models === provider.models && scope.listing.tried && !scope.listing.lastOk);
    scope.listing = null;
    discovered = models;
    const list = modelList(provider, models);
    return message.operation === "modelCatalog"
      ? { models: list, ...(fallback ? { fallback: true } : {}) }
      : list;
  }
  if (message.operation !== "fetch") throw new Error("Unknown plugin operation");
  if (typeof loader?.fetch !== "function")
    throw new Error("Plugin has no authenticated request transport");
  const r = message.request;
  const body = r.body ? new TextDecoder().decode(r.body) : undefined;
  const payload = body ? JSON.parse(body) : {};
  // 冷恢复时 Host 已有目录，可直接发起请求；新 worker 仍需恢复 Zed 的
  // 厂商映射，不能把动态 Gemini ID 当作 provider 默认的 Anthropic。
  if (workerData.channel === "zed" && !discovered && hooks.provider?.models) {
    discovered = await hooks.provider.models(provider, { auth: await currentGrant() });
    check();
  }
  const model = discovered?.[payload.model] ?? provider.models?.[payload.model];
  const { response, signIn } = await fetchPluginModel({
    channel: workerData.channel,
    hooks,
    provider,
    loader,
    model,
    request: r,
    signal: scope.controller.signal,
  });
  if (response.body) scope.reader = response.body.getReader();
  check();
  if (["expired", "kept", "renewed"].includes(signIn)) await credential("signin", signIn);
  const responseHeaders = [...response.headers];
  // Fetch decompresses upstream bytes. Forwarding the old content encoding or
  // content length over the worker transport would corrupt the response.
  const cleanHeaders = responseHeaders.filter(
    ([key]) =>
      !["content-encoding", "content-length", "x-magpie-sign-in"].includes(key.toLowerCase()),
  );
  send({
    kind: "response",
    id: scope.id,
    status: response.status,
    statusText: response.statusText,
    headers: cleanHeaders,
  });
  if (response.body) {
    while (true) {
      check();
      // One chunk in flight provides backpressure all the way to the vendor.
      await new Promise((resolve) => {
        scope.pull = resolve;
        if (scope.credit) {
          scope.credit = false;
          resolve();
        }
      });
      scope.pull = null;
      check();
      const { done, value } = await scope.reader.read();
      if (done) break;
      send({ kind: "chunk", id: scope.id, bytes: value });
    }
  }
  send({ kind: "end", id: scope.id });
  return undefined;
}

let disposing;
function dispose() {
  if (disposing) return disposing;
  closed = true;
  networkTransport.dispose();
  for (const scope of operations.values()) {
    scope.controller.abort();
    scope.rotation?.controller.abort();
    scope.pull?.();
  }
  disposing = (async () => {
    const closing = [networkTransport.disposeAndWait()];
    for (const scope of operations.values()) {
      if (scope.done) closing.push(scope.done);
      readerCleanup.cancel(scope);
    }
    credentials.close();
    for (const child of children) {
      closing.push(new Promise((resolve) => child.once("close", resolve)));
      child.kill();
    }
    for (const server of servers) {
      closing.push(
        new Promise((resolve, reject) => {
          server.closeAllConnections?.();
          server.close((error) =>
            error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve(),
          );
        }),
      );
    }
    const results = await Promise.allSettled(closing);
    // 原 operation 的 finally 也可能登记 reader；等 operation 后再排空同一个账本。
    results.push(...(await Promise.allSettled([readerCleanup.drain()])));
    const failed = results.some((result) => result.status === "rejected");
    // ACK 只在原资源结算后发出；父端仍以真实 exit 为准，不把收到 dispose 当成清理成功。
    send({ kind: "disposed", failed });
    process.exit(failed ? 1 : 0);
  })();
  return disposing;
}
process.on("exit", () => {
  for (const child of children) child.kill();
});
parentPort.on("message", (message) => {
  if (message.kind === "dispose") return dispose();
  if (message.kind === "credential-result") {
    credentials.receive(message);
    return;
  }
  if (message.kind === "pull") {
    const scope = operations.get(message.id);
    if (scope?.pull) {
      const pull = scope.pull;
      scope.pull = null;
      pull();
    } else if (scope) scope.credit = true;
    return;
  }
  if (message.kind === "cancel") {
    const scope = operations.get(message.id);
    scope?.controller.abort();
    scope?.pull?.();
    if (scope) readerCleanup.cancel(scope);
    return;
  }
  if (message.kind !== "call" || closed) return;
  const scope = {
    id: message.id,
    context: message.context,
    network: message.network,
    controller: new AbortController(),
  };
  operations.set(message.id, scope);
  scope.done = scopes.run(scope, async () => {
    try {
      await networkTransport.prepare(scope, message);
      const value = await call(message, scope);
      check();
      if (message.operation !== "fetch") send({ kind: "result", id: message.id, value });
    } catch (error) {
      if (
        scope.context &&
        !scope.controller.signal.aborted &&
        ["expired", "kept", "renewed"].includes(error?.signIn)
      )
        await credential("signin", error.signIn).catch(() => {});
      send({ kind: "error", id: message.id, error: failure(error) });
    } finally {
      readerCleanup.cancel(scope);
      workerRefresh.end(scope);
      operations.delete(message.id);
    }
  });
});
