import { lcodeProtocolMethods, lcodeRuntimeCapabilitiesSchema } from "@lcode/shared";
import type { LCodeProtocolClient } from "./lcodeProtocolClient.js";

const checks = new WeakMap<object, Promise<void>>();

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export function ensureIndependentPlanSupport(
  client: Pick<LCodeProtocolClient, "request">,
): Promise<void> {
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(lcodeProtocolMethods.runtimeCapabilities, {}, lcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.independentPlanState !== true) throw new Error("proto.independentPlanUnsupported");
    })
    .catch((cause: unknown) => {
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}
