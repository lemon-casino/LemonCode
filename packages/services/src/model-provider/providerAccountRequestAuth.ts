import type { AuthWireProtocol } from "@lcode/provider-node";
import type { RoutingInvocation } from "@lcode/shared";
import type { ProviderAccountScheduler } from "./providerAccountScheduler.js";
import type { ProviderAccountStorage } from "./providerAccountStorage.js";
import type { ProviderAccountTransport } from "./providerAccountTransport.js";
import { resolveProviderAccountRoutes } from "./providerAccountRouting.js";

export type ProviderAccountRequestAuthArgs = [
  channelId: string,
  modelId: string,
  protocol?: AuthWireProtocol,
  sessionId?: string,
  invocation?: RoutingInvocation,
];

export async function resolveProviderAccountRequestAuth(
  storage: ProviderAccountStorage,
  routing: ProviderAccountScheduler,
  transport: ProviderAccountTransport,
  channelId: string,
  modelId: string,
  protocol?: AuthWireProtocol,
  sessionId?: string,
  invocation?: RoutingInvocation,
) {
  const enabled = await routing.requireCapability(channelId, invocation);
  const selectedProtocol = resolveProviderAccountRoutes(
    await storage.read(),
    channelId,
    modelId,
    protocol,
  )[0]?.model.protocol;
  if (!selectedProtocol) throw new Error("No authorized account supports this model");
  return {
    ...(await transport.issue(channelId, modelId, selectedProtocol, sessionId, invocation)),
    protocol: selectedProtocol,
    ...(enabled ? { routingFeedback: true as const } : {}),
  };
}
