import type {
  AuthDriver,
  AuthDriverContext,
  AuthModel,
  AuthWireProtocol,
} from "@lcode/provider-node";
import { resolveProviderAccountRoutes } from "./providerAccountRouting.js";
interface PoolAccount {
  connectionId: string;
  channelId: string;
  enabled: boolean;
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
): Promise<Response> {
  const routes = resolveProviderAccountRoutes(await host.read(), channelId, modelId, protocol);
  // 会话工具轮次沿用自己的成功账号，其他会话的切换不能改变当前CLI工具归属。
  const poolKey = JSON.stringify([
    request.headers.get("x-lcode-session-id"),
    channelId,
    protocol,
    modelId,
  ]);
  const preferred = host.preferred.get(poolKey);
  routes.sort(
    (a, b) =>
      Number(b.account.connectionId === preferred) - Number(a.account.connectionId === preferred),
  );
  for (const [index, { account, model }] of routes.entries()) {
    let transferred = false;
    request.signal.throwIfAborted();
    const controller = host.track(account.connectionId);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    try {
      const suffix =
        protocol === "anthropic-messages"
          ? "/messages"
          : protocol === "openai-responses"
            ? "/responses"
            : "/chat/completions";
      const upstream = model.baseURL.replace(/\/+$/u, "") + suffix;
      const response = await host.withAccountLock(account, async () => {
        signal.throwIfAborted();
        return (await host.driver(account)).fetch(
          new Request(upstream, {
            method: "POST",
            headers: request.headers,
            body: await request.clone().arrayBuffer(),
            signal,
          }),
          host.context(account, signal),
        );
      });
      // Copilot 目录可能给账号列出不可调用的模型；仅对驱动确认的模型拒绝尝试同模型的另一账号。
      const modelRefused =
        channelId === "copilot" &&
        response.status === 400 &&
        response.headers.get("x-zcode-model-refused") === "true";
      if (
        ([401, 403, 429, 500, 502, 503, 504].includes(response.status) || modelRefused) &&
        index < routes.length - 1
      ) {
        await response.body?.cancel();
        continue;
      }
      if (response.ok) host.preferred.set(poolKey, account.connectionId);
      const headers = new Headers(response.headers);
      headers.delete("x-zcode-model-refused");
      headers.set("x-zcode-connection-id", account.connectionId);
      const original = response.body;
      const reader = original?.getReader();
      // 持续流的取消必须活到body关闭，不能在收到HTTP headers时释放。
      const stream = reader
        ? new ReadableStream<Uint8Array>({
            pull: async (output) => {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  host.untrack(account.connectionId, controller);
                  output.close();
                } else output.enqueue(chunk.value);
              } catch (error) {
                host.untrack(account.connectionId, controller);
                output.error(error);
              }
            },
            cancel: async () => {
              controller.abort();
              host.untrack(account.connectionId, controller);
              await reader.cancel();
            },
          })
        : null;
      if (!stream) host.untrack(account.connectionId, controller);
      transferred = true;
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      if (request.signal.aborted || index === routes.length - 1) throw error;
    } finally {
      if (!transferred) host.untrack(account.connectionId, controller);
    }
  }
  return new Response(
    JSON.stringify({ error: { message: "No enabled OAuth account supports this model" } }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
