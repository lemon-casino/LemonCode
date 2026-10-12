import { useEffect, useId, useRef, useState } from "react";
import { isNetworkProxyUrl, joinNetworkProxyUrl, splitNetworkProxyUrl } from "@lcode/shared";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

/** URL 保存保持兼容，独立 credential 字段避免在地址文本中明文显示密码。 */
export function ProxyAddressInput({
  value,
  onChange,
  disabled,
  onCommit,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onCommit?: () => void;
}) {
  const { intl } = useLCodeIntl();
  const id = useId();
  const [draft, setDraft] = useState(() => splitNetworkProxyUrl(value));
  const emitted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (value !== emitted.current) setDraft(splitNetworkProxyUrl(value));
  }, [value]);
  const change = (patch: Partial<typeof draft>) => {
    const inline =
      patch.address && isNetworkProxyUrl(patch.address)
        ? splitNetworkProxyUrl(patch.address)
        : undefined;
    // 地址框粘贴完整授权 URI 时，原空白 credential 草稿不能覆盖并删除其中的账号密码。
    const next =
      inline && (inline.username || inline.password)
        ? { ...draft, ...inline }
        : { ...draft, ...patch };
    setDraft(next);
    emitted.current = joinNetworkProxyUrl(next.address, next.username, next.password);
    onChange(emitted.current);
  };
  return (
    <div className="min-w-0 space-y-3">
      <label
        className="block min-w-0 space-y-1 text-ui-base text-foreground-subtle"
        htmlFor={`${id}-address`}
      >
        <span>{intl.formatMessage({ id: "settings.httpProxy" })}</span>
        <Input
          id={`${id}-address`}
          className="font-mono"
          value={draft.address}
          disabled={disabled}
          placeholder={intl.formatMessage({ id: "settings.httpProxyPlaceholder" })}
          onChange={(event) => change({ address: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommit?.();
          }}
        />
      </label>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label
          className="min-w-0 space-y-1 text-ui-base text-foreground-subtle"
          htmlFor={`${id}-username`}
        >
          <span>{intl.formatMessage({ id: "settings.proxy.username" })}</span>
          <Input
            id={`${id}-username`}
            value={draft.username}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => change({ username: event.target.value })}
          />
        </label>
        <label
          className="min-w-0 space-y-1 text-ui-base text-foreground-subtle"
          htmlFor={`${id}-password`}
        >
          <span>{intl.formatMessage({ id: "settings.proxy.password" })}</span>
          <Input
            id={`${id}-password`}
            type="password"
            value={draft.password}
            disabled={disabled}
            autoComplete="new-password"
            onChange={(event) => change({ password: event.target.value })}
          />
        </label>
      </div>
    </div>
  );
}
