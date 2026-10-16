import { routingFailureCodeSchema, type RoutingFailureCode } from "@lcode/shared/provider-routing";

/** 固定原因码不携带上游正文；调用方按 code 判断，不能从 message 猜路由状态。 */
export class RoutingError extends Error {
  readonly code: RoutingFailureCode;
  readonly retryable: boolean;
  constructor(reason: string, options?: ErrorOptions) {
    const code = routingFailureCodeSchema.safeParse(reason).data ?? "no-compatible-route";
    super(code, options);
    this.name = "RoutingError";
    this.code = code;
    this.retryable = ["route-cooling", "concurrency-full", "policy-conflict"].includes(code);
  }
}
