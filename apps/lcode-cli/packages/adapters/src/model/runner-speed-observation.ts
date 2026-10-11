import type { Logger } from "@lcode/contracts";
import type { AiSdkResolvedModel } from "./model-execution.js";
import { readModelSpeedTier, resolveModelSpeedResult } from "./model-speed-observation.js";
import { modelStatusContextToLogContext, type ModelStatusContext } from "./runner-status.js";

export function logModelSpeedObservation(input: {
  readonly logger?: Logger;
  readonly resolved: AiSdkResolvedModel;
  readonly statusContext: ModelStatusContext;
  readonly attempt: number;
}): void {
  const observation = input.resolved.speedObservation;
  if (!observation) return;
  const result = resolveModelSpeedResult(observation);
  const body = input.resolved.rawRequestBodyCapture?.body;
  const context = {
    ...modelStatusContextToLogContext(
      { ...input.statusContext, baseURL: undefined },
      input.attempt,
    ),
    event: "model.speed.observed",
    requestedSpeed: observation.requested,
    responseTier: observation.responseTier ?? null,
    speedResult: result,
    // 只记录有限档位；自定义映射的任意字符串不能进入生产日志。
    sentServiceTier: readModelSpeedTier(body?.service_tier) ?? null,
    sentSpeed: readModelSpeedTier(body?.speed) ?? null,
  };
  if (result === "downgraded" || result === "mismatch") {
    input.logger?.warn(
      "模型响应档位与会话选择不一致 / Model speed differs from requested speed",
      context,
    );
  } else if (result === "unconfirmed" && observation.requested === "fast") {
    input.logger?.warn("供应商未确认快速档位 / Provider did not confirm fast mode", context);
  } else {
    input.logger?.info("模型响应速度档位 / Model response speed observed", context);
  }
}
