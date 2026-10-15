import { lcodeProtocolMethods } from "@lcode/shared";

/** 仅资源 owner 的内部端口可标记 cleanup；不接收客户端传入的 purpose。 */
export function isResourceCleanupRequest(method: string, params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const value = params as Record<string, unknown>;
  if (method === lcodeProtocolMethods.checkoutReleaseWriter)
    return typeof value.permitId === "string" && typeof value.sessionId === "string";
  if (method !== lcodeProtocolMethods.interactionBrowserExecute) return false;
  const command = value.command as { method?: unknown } | undefined;
  return (
    (command?.method === "closeSession" || command?.method === "turnEnded") &&
    typeof value.browserId === "string" &&
    typeof value.browserGeneration === "number" &&
    typeof value.sessionId === "string"
  );
}
