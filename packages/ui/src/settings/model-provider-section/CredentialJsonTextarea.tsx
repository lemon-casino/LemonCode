import { useId, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/** JSON 必须保留原始换行；只拥有显隐状态，凭据草稿仍由授权表单持有。 */
export function CredentialJsonTextarea({
  label,
  value,
  onChange,
  disabled,
  required,
  placeholder,
  secret = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  secret?: boolean;
}) {
  const id = useId();
  const { intl } = useLCodeIntl();
  const [visible, setVisible] = useState(false);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-ui-base">
          {label}
        </label>
        {secret ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
            {intl.formatMessage({
              id: visible ? "settings.oauth.hideJson" : "settings.oauth.showJson",
            })}
          </Button>
        ) : null}
      </div>
      <Textarea
        id={id}
        data-language="json"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        rows={6}
        className={cn(
          "field-sizing-fixed h-40 min-h-40 max-h-40 resize-none overflow-y-auto font-mono text-mobile-input-safe md:text-ui-base",
          secret && !visible && "[-webkit-text-security:disc]",
        )}
      />
    </div>
  );
}
