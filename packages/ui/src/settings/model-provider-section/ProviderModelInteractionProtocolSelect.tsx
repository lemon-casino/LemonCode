import { cn } from "@/components/lib/utils.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { modelEditorControlStyle } from "@/settings/model-provider-section/modelEditorControlStyle.js";
import type { ModelInteractionProtocol } from "@zcode/shared/model-config";
import { useId } from "react";

const MODEL_INTERACTION_PROTOCOLS = [
  "native-tool-calls",
  "ui-tars-text-actions",
] as const satisfies readonly ModelInteractionProtocol[];

export function ProviderModelInteractionProtocolSelect({
  value,
  overridden,
  onChange,
}: {
  value: ModelInteractionProtocol;
  overridden: boolean;
  onChange: (value: ModelInteractionProtocol) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "settings.modelProvider.interactionProtocol" });
  const triggerId = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={triggerId} className="block text-ui-base text-foreground-subtle">
        {label}
      </label>
      <Select value={value} onValueChange={(next) => onChange(next as ModelInteractionProtocol)}>
        <SelectTrigger
          id={triggerId}
          size="lg"
          className={cn("w-full", modelEditorControlStyle(overridden))}
          data-model-interaction-protocol="true"
          data-personal-override={overridden}
          aria-label={label}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {MODEL_INTERACTION_PROTOCOLS.map((protocol) => (
            <SelectItem key={protocol} value={protocol}>
              {intl.formatMessage({
                id: `settings.modelProvider.interactionProtocol.${protocol}`,
              })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
