import { z } from "zod";

const price = z.number().finite().nonnegative();
export const modelBillingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("multiplier"),
      multiplier: price,
      originalMultiplier: price.optional(),
      free: z.literal(true).optional(),
      validUntil: z.string().datetime({ offset: true }).optional(),
    })
    .strict()
    .refine(
      (value) =>
        (!value.free || value.multiplier === 0) &&
        (value.originalMultiplier === undefined || value.originalMultiplier > value.multiplier),
      "Contradictory model billing",
    ),
  z
    .object({
      kind: z.literal("token-credits"),
      input: price,
      output: price,
      cacheRead: price.optional(),
      cacheWrite: price.optional(),
      batchSize: z.number().finite().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
  z.object({ kind: z.literal("mixed") }).strict(),
]);
export type ModelBilling = z.infer<typeof modelBillingSchema>;
export const modelCatalogEntrySchema = z
  .object({
    name: z.string().max(256),
    billing: modelBillingSchema.optional(),
  })
  .strict();
export const accountModelCatalogSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), modelCatalogEntrySchema),
);
export type AccountModelCatalog = z.infer<typeof accountModelCatalogSchema>;

/** 修复：菜单缓存不能让过期的限免继续承诺免费；没有明确原价时回到未知。 */
export function currentModelBilling(
  value: ModelBilling | undefined,
  now = Date.now(),
): ModelBilling | undefined {
  if (value?.kind !== "multiplier" || !value.validUntil || Date.parse(value.validUntil) > now)
    return value;
  return value.originalMultiplier !== undefined
    ? { kind: "multiplier", multiplier: value.originalMultiplier }
    : { kind: "unknown" };
}

/** 多账号实际调用可切换；不借目录中第一个账号的价格代表整个池。 */
export function mergeModelBilling(
  values: readonly (ModelBilling | undefined)[],
  now = Date.now(),
): ModelBilling | undefined {
  const current = values.map((value) => currentModelBilling(value, now));
  if (!current.some((value) => value && value.kind !== "unknown")) return undefined;
  const first = current[0];
  return current.every((value) => JSON.stringify(value) === JSON.stringify(first))
    ? first
    : { kind: "mixed" };
}
