import {
  PROVIDER_ACCOUNT_RELAY_CHUNK_BYTES,
  PROVIDER_ACCOUNT_RELAY_MAX_BODY_BYTES,
  providerAccountRelayOpenSchema,
  providerAccountRelayRequestIdSchema,
  type ProviderAccountRelayOpen,
} from "@lcode/shared";
import type { ProviderAccounts } from "./providerAccounts.js";
import type { ProviderAccountRelayService } from "./providerAccountRelay.js";

interface RelayRequest {
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  pending?: Uint8Array;
  reading: boolean;
}
const paths = {
  "anthropic-messages": "/messages",
  "openai-responses": "/responses",
  "openai-chat-completions": "/chat/completions",
};

/** 每条物理连接独立撤销；账号/续期仍由原 Local Host ProviderAccounts 持有。 */
export function createProviderAccountRelaySource(accounts: ProviderAccounts): {
  service: ProviderAccountRelayService;
  dispose(): void;
} {
  const requests = new Map<string, RelayRequest>();
  let disposed = false;
  const cancel = async (id: string): Promise<void> => {
    providerAccountRelayRequestIdSchema.parse(id);
    const current = requests.get(id);
    if (!current) return;
    requests.delete(id);
    current.controller.abort();
    await current.reader?.cancel().catch(() => {});
  };
  const service: ProviderAccountRelayService = {
    onDidChange: accounts.onDidChange,
    getView: () => accounts.getView(),
    checkinAccount: (id) => accounts.checkinAccount(id),
    checkinAll: (channel) => accounts.checkinAll(channel),
    setAutomaticCheckin: (id, enabled) => accounts.setAutomaticCheckin(id, enabled),
    startAuthorization: (input) => accounts.startAuthorization(input),
    getAuthorization: (id) => accounts.getAuthorization(id),
    completeAuthorization: (id, code) => accounts.completeAuthorization(id, code),
    cancelAuthorization: (id) => accounts.cancelAuthorization(id),
    refreshModels: (id) => accounts.refreshModels(id),
    getQuota: (id, force) => accounts.getQuota(id, force),
    removeAccount: (id) => accounts.removeAccount(id),
    setAccountEnabled: (id, enabled) => accounts.setAccountEnabled(id, enabled),
    async open(input) {
      let request: ProviderAccountRelayOpen;
      let body: Buffer;
      try {
        request = providerAccountRelayOpenSchema.parse(input);
        body = Buffer.from(request.body, "base64");
        if (
          body.length > PROVIDER_ACCOUNT_RELAY_MAX_BODY_BYTES ||
          JSON.parse(body.toString("utf8"))?.model !== request.modelId
        )
          throw new Error("invalid model");
      } catch {
        throw new Error("OAuth relay model request invalid");
      }
      if (disposed || requests.has(request.requestId))
        throw new Error("OAuth relay request unavailable");
      const current: RelayRequest = { controller: new AbortController(), reading: false };
      requests.set(request.requestId, current);
      try {
        const auth = await accounts.resolveRequestAuth(
          request.channelId,
          request.modelId,
          request.protocol,
          request.sessionId,
        );
        current.controller.signal.throwIfAborted();
        // 修复：远端 OAuth 目录原先缺少账号事实；调用复用本机 owner，不能复制凭据或本机 localhost。
        const response = await fetch(`${auth.baseURL}${paths[auth.protocol]}`, {
          method: "POST",
          headers: {
            ...request.headers,
            "content-type": "application/json",
            authorization: `Bearer ${auth.apiKey}`,
          },
          body,
          signal: current.controller.signal,
        });
        current.controller.signal.throwIfAborted();
        current.reader = response.body?.getReader();
        const headers: Record<string, string> = {};
        for (const key of ["content-type", "retry-after", "x-zcode-connection-id"]) {
          const value = response.headers.get(key);
          if (value) headers[key] = value;
        }
        return { status: response.status, headers };
      } catch {
        await cancel(request.requestId);
        // 任意 driver 错误可能带请求材料；私有 RPC 也只返回固定错误，不串出 token/body。
        throw new Error("OAuth relay model request failed");
      }
    },
    async read(id) {
      providerAccountRelayRequestIdSchema.parse(id);
      const current = requests.get(id);
      if (!current || current.reading) throw new Error("OAuth relay request unavailable");
      current.reading = true;
      try {
        current.controller.signal.throwIfAborted();
        let bytes = current.pending;
        if (!bytes) {
          const next = await current.reader?.read();
          current.controller.signal.throwIfAborted();
          if (!next || next.done) {
            requests.delete(id);
            current.reader?.releaseLock();
            return { done: true };
          }
          bytes = next.value;
        }
        const chunk = bytes.subarray(0, PROVIDER_ACCOUNT_RELAY_CHUNK_BYTES);
        current.pending = bytes.length > chunk.length ? bytes.subarray(chunk.length) : undefined;
        return { done: false, data: Buffer.from(chunk).toString("base64") };
      } catch {
        await cancel(id);
        throw new Error("OAuth relay response unavailable");
      } finally {
        current.reading = false;
      }
    },
    cancel,
  };
  return {
    service,
    dispose() {
      disposed = true;
      for (const id of requests.keys()) void cancel(id);
    },
  };
}
