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
import { codex, copilot, google } from "./providerAccountNativeQuotas.js";
export type { QuotaReading } from "./providerAccountQuotaFields.js";

function pluginWindow(channel: string, value: Data): Data {
  // 固定插件的这些行以 used:0 占位展示余额/提示，并没有额度分母；aside 也用于真实额度，不能全删。
  const informationOnly =
    (channel === "cline" && value.name === "Credits") ||
    (channel === "factory" && value.name === "Extra usage") ||
    (channel === "cursor" && value.name === "On-demand") ||
    ((channel === "bigmodel" || channel === "zai") &&
      value.name === "Gift plans to claim in the ZCode app");
  return informationOnly &&
    value.aside === true &&
    number(value.used) === 0 &&
    typeof value.display === "string" &&
    number(value.amount) === undefined &&
    number(value.limit) === undefined
    ? { ...value, used: undefined }
    : value;
}
/** Only known numeric/label fields leave Host; raw payloads, account identities and errors never do. */
export function normalizeProviderAccountQuota(
  channel: string,
  value: unknown,
  now: number,
): QuotaReading {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { status: "error", windows: [], error: "invalid_response" };
  const raw = record(value);
  if (raw.status === "unsupported" || raw.supported === false)
    return { status: "unsupported", windows: [] };
  const result =
    channel === "codex"
      ? codex(raw, now)
      : channel === "copilot"
        ? copilot(raw, now)
        : channel === "gemini" || channel === "antigravity"
          ? google(channel, raw, now)
          : finish(
              list(raw.windows).map((w, i) =>
                windowOf(
                  label(w.id) ?? `window-${i}`,
                  label(w.name) ?? "Allowance",
                  pluginWindow(channel, w),
                  now,
                ),
              ),
              label(raw.plan),
              label(raw.balance),
            );
  // Cline/MiniMax 的部分接口可失败；保留当次有效额度，不让旧缓存覆盖新的成功字段。
  if (raw.error && result.status !== "ready")
    return { status: "error", windows: [], error: "request_failed" };
  const planExpiresAt = date(raw.until);
  return {
    ...result,
    ...(raw.error || raw.partial === true ? { partial: true } : {}),
    ...(planExpiresAt ? { planExpiresAt } : {}),
    ...(raw.renew === "auto" || raw.renew === "off" ? { renewal: raw.renew } : {}),
  };
}
