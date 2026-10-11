import { wrapLanguageModel } from "ai";

type SdkModel = Parameters<typeof wrapLanguageModel>[0]["model"];
const FAST_TIERS = new Set(["fast", "priority", "performance", "ultrafast"]);
const STANDARD_TIERS = new Set(["standard", "default", "on_demand"]);
const KNOWN_TIERS = new Set([...FAST_TIERS, ...STANDARD_TIERS, "auto", "flex", "scale"]);

export function readModelSpeedTier(value: unknown): string | undefined {
  return typeof value === "string" && KNOWN_TIERS.has(value) ? value : undefined;
}

/** 每次 resolveRequest 独占；响应事实不能反写会话选择或复用到下一次重试。 */
export interface ModelSpeedObservation {
  readonly requested: string;
  responseTier?: string;
}

export function resolveModelSpeedResult(
  observation: ModelSpeedObservation,
): "confirmed" | "downgraded" | "unconfirmed" | "mismatch" {
  const tier = observation.responseTier;
  if (!tier || !KNOWN_TIERS.has(tier) || tier === "auto" || tier === "scale") return "unconfirmed";
  if (observation.requested === "fast") {
    return FAST_TIERS.has(tier) ? "confirmed" : "downgraded";
  }
  if (observation.requested === "standard") {
    return STANDARD_TIERS.has(tier) ? "confirmed" : "mismatch";
  }
  return "unconfirmed";
}

export function observeModelSpeed(model: SdkModel, observation: ModelSpeedObservation): SdkModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({ doGenerate }) {
        observation.responseTier = undefined;
        const result = await doGenerate();
        observeResponse(observation, result.response?.body);
        return result;
      },
      async wrapStream({ params, model: source }) {
        observation.responseTier = undefined;
        // Bug 原因：请求 fast 曾被直接当成生效，SDK 又会丢掉兼容中转的 service_tier。
        // 在 SDK 原始事件边界只提取白名单档位，不缓存正文、不 tee、不改变重试或取消。
        const result = await source.doStream({ ...params, includeRawChunks: true });
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                if (chunk.type === "raw") {
                  observeResponse(observation, chunk.rawValue);
                  // compact 等已有消费者显式请求 raw 时，仍保留原来的事件边界。
                  if (!params.includeRawChunks) return;
                }
                controller.enqueue(chunk);
              },
            }),
          ),
        };
      },
    },
  });
}

function observeResponse(observation: ModelSpeedObservation, value: unknown): void {
  const body = record(value);
  const response = record(body.response);
  const message = record(body.message);
  const tier =
    body.service_tier ??
    response.service_tier ??
    record(body.usage).speed ??
    record(message.usage).speed;
  if (tier !== undefined) {
    observation.responseTier = readModelSpeedTier(tier);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
