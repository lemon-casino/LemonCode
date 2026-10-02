import { memo } from "react";
import type { ProviderApiKey } from "@lcode/provider";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderApiKeyProbeState } from "./useProviderApiKeyManager.js";

export const ProviderApiKeyRow = memo(function ProviderApiKeyRow({
  entry: key,
  index,
  status,
  visible,
  disabled,
  updateKey,
  removeKey,
}: {
  entry: ProviderApiKey;
  index: number;
  status: ProviderApiKeyProbeState | undefined;
  visible: boolean;
  disabled: boolean;
  updateKey: (index: number, patch: Partial<ProviderApiKey>) => void;
  removeKey: (index: number) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div
      data-api-key-row
      className="grid grid-cols-1 items-center gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-[minmax(7rem,0.35fr)_minmax(12rem,1fr)_auto_auto]"
    >
      <Input
        size="lg"
        value={key.label ?? ""}
        aria-label={intl.formatMessage(
          { id: "settings.modelProvider.apiKeyManager.label" },
          { index: index + 1 },
        )}
        placeholder={`API Key ${index + 1}`}
        disabled={disabled}
        onChange={(event) => updateKey(index, { label: event.target.value })}
      />
      <div className="min-w-0">
        <Input
          size="lg"
          type={visible ? "text" : "password"}
          value={key.apiKey}
          className="font-mono"
          aria-label={`API Key ${index + 1}`}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => updateKey(index, { apiKey: event.target.value })}
        />
        {status ? (
          <p
            className={`mt-1 text-ui-sm ${status === "valid" ? "text-success" : status === "invalid" ? "text-destructive" : "text-foreground-subtle"}`}
          >
            {intl.formatMessage({
              id: `settings.modelProvider.apiKeyManager.status.${status}`,
            })}
          </p>
        ) : null}
      </div>
      <Switch
        checked={key.enabled !== false}
        disabled={disabled}
        aria-label={intl.formatMessage({
          id: "settings.modelProvider.apiKeyManager.enabled",
        })}
        onCheckedChange={(enabled) => updateKey(index, { enabled })}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        aria-label={intl.formatMessage({ id: "common.delete" })}
        onClick={() => removeKey(index)}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
});
