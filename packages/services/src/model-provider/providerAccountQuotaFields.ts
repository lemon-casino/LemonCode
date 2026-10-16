import type { ProviderAccountQuota, ProviderAccountQuotaWindow } from "@lcode/shared";

export type Data = Record<string, unknown>;
export type QuotaReading = Pick<
  ProviderAccountQuota,
  "status" | "windows" | "plan" | "balance" | "error" | "partial" | "planExpiresAt" | "renewal"
>;
export const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
export const list = (value: unknown): Data[] =>
  Array.isArray(value) ? value.slice(0, 100).map(record) : [];
export function number(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
// 厂商错误正文可夹带认证信息；只投影命名字段，文本仍拒绝凭据形式和控制字符。
export function label(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (
    !text ||
    text.length > max ||
    [...text].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /https?:\/\/|bearer\s|cookie|authorization|(?:access|refresh)[_-]?token|password|secret|eyJ[\w-]+\.|[A-Za-z0-9_-]{60}/iu.test(
      text,
    )
  )
    return undefined;
  return text;
}
export function date(value: unknown): string | undefined {
  const n = number(value);
  const ms =
    n !== undefined
      ? n < 1e11
        ? n * 1000
        : n
      : typeof value === "string" && /^\d{4}-\d\d-\d\d(?:T.*)?$/u.test(value)
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 253402300799999
    ? new Date(ms).toISOString()
    : undefined;
}
function reset(value: unknown, seconds: unknown, now: number): string | undefined {
  const at = date(value),
    after = number(seconds);
  return (
    at ??
    (after !== undefined && after <= 315360000
      ? new Date(now + after * 1000).toISOString()
      : undefined)
  );
}
export function windowOf(
  id: string,
  name: string,
  value: Data,
  now: number,
): ProviderAccountQuotaWindow {
  const used = number(value.amount),
    limit = number(value.limit);
  const remaining =
    number(value.remaining) ??
    (used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined);
  const percent =
    value.unlimited === true
      ? undefined
      : (number(value.used) ??
        (used !== undefined && limit !== undefined && limit > 0
          ? (100 * used) / limit
          : undefined));
  return {
    id,
    name,
    ...(value.kind === "rate" ||
    value.kind === "budget" ||
    value.kind === "expiring-balance" ||
    value.kind === "informational" ||
    value.kind === "unknown"
      ? { kind: value.kind }
      : {}),
    ...(label(value.instanceId) ? { instanceId: label(value.instanceId) } : {}),
    ...(typeof value.stableId === "boolean" ? { stableId: value.stableId } : {}),
    ...(label(value.quotaPoolId) ? { quotaPoolId: label(value.quotaPoolId) } : {}),
    ...(value.scope === "account" ||
    value.scope === "organization" ||
    value.scope === "model" ||
    value.scope === "shared" ||
    value.scope === "unknown"
      ? { scope: value.scope }
      : {}),
    ...(value.resetMode === "fixed" ||
    value.resetMode === "rolling" ||
    value.resetMode === "none" ||
    value.resetMode === "unknown"
      ? { resetMode: value.resetMode }
      : {}),
    ...(Array.isArray(value.includedModelIds)
      ? {
          includedModelIds: value.includedModelIds
            .slice(0, 100)
            .map((id) => label(id))
            .filter((id): id is string => Boolean(id)),
        }
      : {}),
    ...(Array.isArray(value.excludedModelIds)
      ? {
          excludedModelIds: value.excludedModelIds
            .slice(0, 100)
            .map((id) => label(id))
            .filter((id): id is string => Boolean(id)),
        }
      : {}),
    ...(date(value.expiresAt) ? { expiresAt: date(value.expiresAt) } : {}),
    ...(percent !== undefined
      ? { usedPercent: Math.min(100, percent), remainingPercent: Math.max(0, 100 - percent) }
      : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(label(value.unit, 40) ? { unit: label(value.unit, 40) } : {}),
    ...(label(value.display) ? { display: label(value.display) } : {}),
    ...(value.unlimited === true ? { unlimited: true } : {}),
    ...(reset(value.resetsAt, value.resetSecs, now)
      ? { resetAt: reset(value.resetsAt, value.resetSecs, now) }
      : {}),
    ...(label(value.model) ? { modelId: label(value.model) } : {}),
    ...(label(value.pool) ? { pool: label(value.pool) } : {}),
  };
}

export function finish(
  windows: ProviderAccountQuotaWindow[],
  plan?: string,
  balance?: string,
): QuotaReading {
  const known =
    !!balance ||
    windows.some(
      (w) =>
        w.unlimited ||
        w.usedPercent !== undefined ||
        w.used !== undefined ||
        w.remaining !== undefined ||
        w.limit !== undefined ||
        w.display,
    );
  return {
    status: known ? "ready" : "unknown",
    windows,
    ...(plan ? { plan } : {}),
    ...(balance ? { balance } : {}),
  };
}
