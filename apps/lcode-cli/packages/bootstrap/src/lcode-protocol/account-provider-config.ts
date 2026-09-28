import {
  lcodeProviderUpdateAccountConfigParamsSchema,
  type LCodeProviderUpdateAccountConfigResult,
} from "@lcode/shared";
import { parseProcessAccountProviderConfigSnapshot } from "../app/process-provider-registry-runtime.js";
import {
  parseParams,
  ProtocolRequestError,
  type LCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * 更新进程级 Account Provider Config。
 *
 * 该协议传 Account Overlay 与对应状态；API Key、JWT 和动态 Header 由请求期鉴权协议处理。
 */
export async function updateAccountProviderConfig(
  context: LCodeProtocolAgentServerContext,
  params: unknown,
): Promise<LCodeProviderUpdateAccountConfigResult> {
  const envelope = parseParams(lcodeProviderUpdateAccountConfigParamsSchema, params);
  const snapshot = parseProcessAccountProviderConfigSnapshot(envelope);
  if (!context.deps.syncAccountProviderConfig) {
    throw new ProtocolRequestError(-32018, "Account Provider Config runtime is not configured");
  }
  const changed = await context.deps.syncAccountProviderConfig(snapshot);
  return {
    receivedRevision: snapshot.revision,
    providerCount: snapshot.providers.keys().length,
    status: changed ? "received" : "unchanged",
  };
}
