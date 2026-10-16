import type {
  AuthDriver,
  AuthDriverContext,
  AuthModel,
  AuthWireProtocol,
} from "@lcode/provider-node";
import { resolveProviderAccountRoutes } from "./providerAccountRouting.js";
import type { ProviderAccountScheduler } from "./providerAccountScheduler.js";
import type { RoutingInvocation } from "@lcode/shared";
import { RoutingError } from "@lcode/provider";
interface PoolAccount {
  connectionId: string;
  channelId: string;
  enabled: boolean;
  generation: number;
  models: readonly AuthModel[];
}
interface PoolHost<T extends PoolAccount> {
  read(): Promise<T[]>;
  driver(account: T): Promise<AuthDriver>;
  context(account: T, signal: AbortSignal): AuthDriverContext;
  track(id: string): AbortController;
  untrack(id: string, controller: AbortController): void;
  preferred: Map<string, string>;
  withAccountLock<R>(account: T, operation: () => Promise<R>): Promise<R>;
}
export async function executeProviderAccountPool<T extends PoolAccount>(
  host: PoolHost<T>,
  channelId: string,
  modelId: string,
  protocol: AuthWireProtocol,
  request: Request,
  routing?: ProviderAccountScheduler,
  invocation?: RoutingInvocation,
): Promise<Response> {
  let routes = resolveProviderAccountRoutes(await host.read(), channelId, modelId, protocol);
  const selected = await routing?.reserve(channelId, routes, request, invocation);
  if (selected)
    routes = routes.filter((route) => route.account.connectionId === selected.lease.routeId);
  // 会话工具轮次沿用自己的成功账号，其他会话的切换不能改变当前CLI工具归属。
  const poolKey = JSON.stringify([
    request.headers.get("x-lcode-session-id"),
    channelId,
    protocol,
    modelId,
  ]);
  const preferred = selected ? undefined : host.preferred.get(poolKey);
  routes.sort(
    (a, b) =>
      Number(b.account.connectionId === preferred) - Number(a.account.connectionId === preferred),
  );
  for (const [index, { account, model }] of routes.entries()) {
    let transferred = false;
    let dispatched = false;
    const controller = host.track(account.connectionId);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    try {
      request.signal.throwIfAborted();
      const suffix =
        protocol === "anthropic-messages"
          ? "/messages"
          : protocol === "openai-responses"
            ? "/responses"
            : "/chat/completions";
      const upstream = model.baseURL.replace(/\/+$/u, "") + suffix;
      const response = await host.withAccountLock(account, async () => {
        signal.throwIfAborted();
        const driver = await host.driver(account);
        if (selected && !driver.routingSingleAttempt)
          throw new RoutingError("routing-capability-required");
        const body = await request.clone().arrayBuffer();
        await selected?.validate();
        signal.throwIfAborted();
        if (selected && !selected.lease.dispatch())
          throw new RoutingError("attempt-already-dispatched");
        dispatched = true;
        const headers = new Headers(request.headers);
        if (selected) headers.delete("x-lcode-session-id");
        return driver.fetch(
          new Request(upstream, {
            method: "POST",
            headers,
            body,
            signal,
          }),
          { ...host.context(account, signal), ...(selected ? { routingSingleAttempt: true } : {}) },
        );
      });
      // Copilot 目录可能给账号列出不可调用的模型；仅对驱动确认的模型拒绝尝试同模型的另一账号。
      const modelRefused =
        channelId === "copilot" &&
        response.status === 400 &&
        response.headers.get("x-zcode-model-refused") === "true";
      if (
        ([401, 403, 429, 500, 502, 503, 504].includes(response.status) || modelRefused) &&
        !selected &&
        index < routes.length - 1
      ) {
        await response.body?.cancel();
        continue;
      }
      if (!selected && response.ok) host.preferred.set(poolKey, account.connectionId);
      const headers = new Headers(response.headers);
      headers.delete("x-zcode-model-refused");
      headers.set("x-zcode-connection-id", account.connectionId);
      if (selected) {
        headers.set("x-zcode-routing-strategy", selected.plan.effectiveStrategy);
        headers.set("x-zcode-routing-reason", selected.plan.fallbackReason ?? selected.plan.reason);
      }
      const original = response.body;
      const reader = original?.getReader();
      let cancellation: Promise<void> | undefined;
      let finished = false;
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        selected?.finish(account, response, success);
        host.untrack(account.connectionId, controller);
      };
      // pending read 变成 done 早于底层 cancel 完成，不能据此提前返还并发容量。
      const cancelPhysical = (reason?: unknown) =>
        (cancellation ??= (reader?.cancel(reason) ?? Promise.resolve()).finally(() =>
          finish(false),
        ));
      const abort = () => {
        void cancelPhysical(signal.reason).catch(() => {});
      };
      if (reader) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      // 持续流的取消必须活到body关闭，不能在收到HTTP headers时释放。
      const stream = reader
        ? new ReadableStream<Uint8Array>({
            pull: async (output) => {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  if (!cancellation) finish(response.ok && !signal.aborted);
                  output.close();
                } else output.enqueue(chunk.value);
              } catch (error) {
                if (!cancellation) finish(false);
                output.error(error);
              }
            },
            cancel: async () => {
              controller.abort();
              await cancelPhysical();
            },
          })
        : null;
      if (!stream) finish(response.ok);
      transferred = true;
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      if (selected || request.signal.aborted || index === routes.length - 1) throw error;
    } finally {
      if (!transferred) {
        if (selected) {
          if (dispatched) selected.finish(account);
          else selected.lease.cancel();
        }
        host.untrack(account.connectionId, controller);
      }
    }
  }
  return new Response(
    JSON.stringify({ error: { message: "No enabled OAuth account supports this model" } }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
