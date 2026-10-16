import {
  routingFailureCodeSchema,
  type RoutingFailureCode,
  type RoutingFailureInfo,
} from "@lcode/shared/provider-routing";

/** 固定原因码不携带上游正文；调用方按 code 判断，不能从 message 猜路由状态。 */
export class RoutingError extends Error {
  readonly code: RoutingFailureCode;
  readonly retryable: boolean;
  readonly details: RoutingFailureInfo;
  constructor(reason: string, options?: ErrorOptions & Omit<RoutingFailureInfo, "code">) {
    const code = routingFailureCodeSchema.safeParse(reason).data ?? "no-compatible-route";
    super(code, options);
    this.name = "RoutingError";
    this.code = code;
    this.details = {
      code,
      ...(options?.scope ? { scope: options.scope } : {}),
      ...(options?.phase ? { phase: options.phase } : {}),
      ...(options?.retryAt !== undefined ? { retryAt: options.retryAt } : {}),
      ...(options?.dispatch ? { dispatch: options.dispatch } : {}),
    };
    this.retryable = ["route-cooling", "concurrency-full", "policy-conflict"].includes(code);
  }
}
