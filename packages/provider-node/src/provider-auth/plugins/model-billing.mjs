const valid = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 原始插件 cost=0 是 SDK 占位；只有厂商显式 free 或有效正倍率才是计费事实。 */
export function modelBilling(model) {
  const rate = model.rate;
  if (!(valid(rate) && rate > 0) && model.free !== true) return;
  return {
    kind: "multiplier",
    multiplier: valid(rate) ? rate : 0,
    ...(model.free === true && (!valid(rate) || rate === 0) ? { free: true } : {}),
    ...(valid(model.rateWas) && model.rateWas > (valid(rate) ? rate : 0)
      ? { originalMultiplier: model.rateWas }
      : {}),
  };
}
