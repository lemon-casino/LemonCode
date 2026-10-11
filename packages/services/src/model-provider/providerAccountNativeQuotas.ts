import type { ProviderAccountQuotaWindow } from "@lcode/shared";
import {
  record,
  list,
  number,
  label,
  date,
  windowOf,
  finish,
  type Data,
  type QuotaReading,
} from "./providerAccountQuotaFields.js";

export function codex(raw: Data, now: number): QuotaReading {
  const rate = record(raw.rate_limit),
    windows: ProviderAccountQuotaWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const w = record(rate[key]);
    if (!Object.keys(w).length) continue;
    const span = number(w.limit_window_seconds);
    const name =
      span && span % 86400 === 0
        ? `${span / 86400} days`
        : span && span % 3600 === 0
          ? `${span / 3600} hours`
          : "Allowance";
    windows.push(
      windowOf(
        key,
        name,
        { used: w.used_percent, resetsAt: w.reset_at, resetSecs: w.reset_after_seconds },
        now,
      ),
    );
  }
  const credits = record(raw.credits),
    balance = number(credits.balance);
  if (credits.unlimited === true) windows.push({ id: "credits", name: "Credits", unlimited: true });
  const resetCredits = record(raw.resetCredits);
  const available =
    number(resetCredits.available_count) ??
    number(record(raw.rate_limit_reset_credits).available_count);
  if (available !== undefined) {
    const expiresAt = list(resetCredits.credits)
      .filter((credit) => credit.status === "available")
      .map((credit) => date(credit.expires_at))
      .filter((value): value is string => value !== undefined && Date.parse(value) > now)
      .sort()[0];
    windows.push({
      id: "reset-credits",
      name: "Rate limit resets",
      remaining: available,
      unit: "resets",
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  const cap = record(record(raw.spend_control).individual_limit);
  if (Object.keys(cap).length)
    windows.push(
      windowOf(
        "spend-cap",
        "Workspace spending limit",
        {
          used: cap.used_percent,
          amount: cap.used,
          remaining: cap.remaining,
          limit: cap.limit,
          unit: cap.unit,
          resetsAt: cap.reset_at,
          resetSecs: cap.reset_after_seconds,
        },
        now,
      ),
    );
  return finish(
    windows,
    label(raw.plan_type),
    balance !== undefined ? `${balance} credits` : undefined,
  );
}
export function copilot(raw: Data, now: number): QuotaReading {
  const snapshots = record(raw.quota_snapshots),
    windows: ProviderAccountQuotaWindow[] = [];
  for (const [id, name] of [
    ["chat", "Chat requests"],
    ["completions", "Completions"],
    ["premium_interactions", "Premium requests"],
  ]) {
    const w = record(snapshots[id!]);
    if (!Object.keys(w).length) continue;
    const ent = number(w.entitlement),
      left = number(w.quota_remaining),
      remaining = number(w.percent_remaining);
    const exhaustedPool =
      id === "premium_interactions" && w.unlimited === true && w.has_quota === false;
    const unlimited = w.unlimited === true && !exhaustedPool;
    if (!unlimited && !exhaustedPool && ent === 0) continue;
    const used = ent !== undefined && left !== undefined ? Math.max(0, ent - left) : undefined;
    windows.push(
      windowOf(
        id!,
        name!,
        {
          unlimited,
          used: exhaustedPool
            ? 100
            : ent && used !== undefined
              ? (100 * used) / ent
              : remaining !== undefined
                ? Math.max(0, 100 - remaining)
                : undefined,
          // unlimited 的 entitlement/quota_remaining 是上游占位值，展示为零限额会与“无限”矛盾。
          amount: unlimited ? undefined : used,
          remaining: unlimited ? undefined : left,
          limit: unlimited ? undefined : ent,
          unit:
            w.token_based_billing === true || raw.token_based_billing === true
              ? undefined
              : "requests",
          // quota_reset_at=0 是厂商占位值，不能挡住有效的账号级重置日期。
          resetsAt:
            date(w.quota_reset_at) ?? date(raw.quota_reset_date_utc) ?? date(raw.quota_reset_date),
        },
        now,
      ),
    );
  }
  const plans: Record<string, string> = {
    individual: "Pro",
    individual_pro: "Pro+",
    individual_max: "Max",
    individual_edu: "Education",
    business: "Business",
    enterprise: "Enterprise",
    free: "Free",
  };
  const plan =
    raw.access_type_sku === "free_educational_quota"
      ? "Education"
      : raw.access_type_sku === "free_limited_copilot"
        ? "Free"
        : (plans[String(raw.copilot_plan)] ?? label(raw.copilot_plan));
  return finish(windows, plan);
}
export function google(channel: string, raw: Data, now: number): QuotaReading {
  const windows: ProviderAccountQuotaWindow[] = [];
  const add = (bucket: Data, id: string, name: string, pool?: string) => {
    if (bucket.disabled === true || windows.length >= 100) return;
    // Antigravity 已识别额度对象的省略 fraction 表示耗尽；Gemini 缺失仍保持未知。
    const remaining =
      number(bucket.remainingFraction) ??
      (channel === "antigravity" && !Object.hasOwn(bucket, "remainingFraction") ? 0 : undefined);
    windows.push(
      windowOf(
        id,
        name,
        {
          used: remaining === undefined ? undefined : (1 - Math.min(1, remaining)) * 100,
          resetsAt: bucket.resetTime,
          model: bucket.modelId,
          pool,
        },
        now,
      ),
    );
  };
  if (channel === "gemini") {
    const seen = new Set<string>();
    for (const [index, bucket] of list(raw.buckets).entries()) {
      const model = label(bucket.modelId);
      if (model?.endsWith("_vertex") || (model && seen.has(model))) continue;
      if (model) seen.add(model);
      add(bucket, model ? `model-${model}` : `bucket-${index}`, model ?? "Allowance");
    }
  } else {
    for (const [groupIndex, group] of list(raw.groups).entries()) {
      const pool = label(group.displayName);
      for (const [index, bucket] of list(group.buckets).entries()) {
        if (windows.length >= 100) break;
        // 缺少 fraction 表示耗尽只适用于已识别的额度结构，不能套用于空对象或非法数组项。
        if (
          !label(bucket.bucketId) &&
          !label(bucket.window) &&
          !label(bucket.displayName) &&
          !date(bucket.resetTime) &&
          number(bucket.remainingFraction) === undefined
        )
          continue;
        add(
          bucket,
          `group-${groupIndex}-${index}`,
          label(bucket.displayName) ?? label(bucket.window) ?? "Allowance",
          pool,
        );
      }
    }
    for (const [index, [id, value]] of Object.entries(record(raw.models)).slice(0, 100).entries()) {
      const model = record(value);
      if (model.disabled === true || id.startsWith("chat_") || id.startsWith("tab_")) continue;
      if (!model.quotaInfo || typeof model.quotaInfo !== "object" || Array.isArray(model.quotaInfo))
        continue;
      // 上游键同样是不可信文本；不能绕过白名单进入窗口 ID/名称，或超出 DTO 长度。
      const modelId = label(id);
      add(
        { ...record(model.quotaInfo), modelId },
        `model-${modelId ?? index}`,
        label(model.displayName) ?? modelId ?? "Allowance",
      );
    }
  }
  return finish(windows, label(raw.plan));
}
