import { useEffect, useState } from "react";
import { currentModelBilling, type ModelBilling } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ModelBillingBadge({ billing }: { billing?: ModelBilling }) {
  const { intl, locale } = useLCodeIntl();
  const [now, setNow] = useState(Date.now);
  const until = billing?.kind === "multiplier" ? billing.validUntil : undefined;
  useEffect(() => {
    if (!until) return;
    // 促销到期时仅刷新展示，不创建另一份目录或通过轮询改写账号事实。
    const delay = Math.max(0, Date.parse(until) - Date.now());
    if (!delay) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [until, now]);
  const value = currentModelBilling(billing, Math.max(now, Date.now()));
  if (!value || value.kind === "unknown") return null;
  const msg = (key: string) => intl.formatMessage({ id: `model.billing.${key}` });
  const times = (n: number) => `${n.toLocaleString(locale, { maximumFractionDigits: 4 })}×`;
  let label: string, detail: string;
  if (value.kind === "multiplier") {
    label = value.free ? msg("free") : times(value.multiplier);
    detail = msg("multiplierHint");
    if (value.validUntil) detail += ` · ${new Date(value.validUntil).toLocaleString(locale)}`;
  } else if (value.kind === "token-credits") {
    label = msg("credits");
    detail = intl.formatMessage(
      { id: "model.billing.creditsHint" },
      {
        input: value.input,
        output: value.output,
        batch: value.batchSize,
      },
    );
  } else {
    label = msg(value.kind);
    detail = msg(`${value.kind}Hint`);
  }
  return (
    <span
      className="inline-flex max-w-full items-center justify-end gap-1 text-ui-xs tabular-nums text-foreground-subtle"
      data-model-billing={value.kind}
      title={detail}
      aria-label={`${label}: ${detail}`}
    >
      {value.kind === "multiplier" && value.originalMultiplier !== undefined ? (
        <s className="text-foreground-subtlest">{times(value.originalMultiplier)}</s>
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}
