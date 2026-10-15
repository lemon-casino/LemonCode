import type { ModelBilling } from "@lcode/shared";
import { record, type Json } from "./common.js";
const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Copilot 新账号按 token 扣 AI Credits；旧倍率不能替代 token 单价。 */
export function copilotBilling(raw: Json, tokenBased?: boolean): ModelBilling | undefined {
  const prices = record(raw.tokenPrices ?? raw.token_prices);
  const input = prices.inputPrice ?? prices.input_price;
  const output = prices.outputPrice ?? prices.output_price;
  const batchSize = prices.batchSize ?? prices.batch_size;
  if (tokenBased !== false && valid(input) && valid(output) && valid(batchSize) && batchSize > 0) {
    const cacheRead = prices.cachePrice ?? prices.cache_price;
    const cacheWrite = prices.cacheWritePrice ?? prices.cache_write_price;
    return {
      kind: "token-credits",
      input,
      output,
      batchSize,
      ...(valid(cacheRead) ? { cacheRead } : {}),
      ...(valid(cacheWrite) ? { cacheWrite } : {}),
    };
  }
  if (tokenBased !== false || !valid(raw.multiplier)) return;
  return {
    kind: "multiplier",
    multiplier: raw.multiplier,
    ...(raw.multiplier === 0 ? { free: true } : {}),
  };
}
