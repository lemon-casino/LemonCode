import { setImmediate as immediate } from "node:timers/promises";
import type { RoutingScheduler, RoutingRequest } from "@lcode/provider";
/** IO adapter 驱动纯投影 generator；一个等待者取消不会关闭目录里共享的 builder。 */
export async function prepareApiKeyIndex(
  owner: RoutingScheduler,
  input: RoutingRequest,
  signal: AbortSignal,
): Promise<void> {
  for (const _ of owner.prepareIndexed({ ...input, signal })) {
    signal.throwIfAborted();
    await immediate();
  }
  signal.throwIfAborted();
}
