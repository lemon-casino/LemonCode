import { GaugeIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ModelSpeedControlProps {
  values: readonly string[];
  value: string;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  labelClassName?: string;
}

export function ModelSpeedControl({
  values,
  value,
  disabled,
  open,
  onOpenChange,
  onValueChange,
  intl,
  labelClassName = "hidden @lg/composer:inline",
}: ModelSpeedControlProps) {
  const label = (speed: string) =>
    speed === "fast"
      ? intl.formatMessage({ id: "chat.toolbar.speed.fast" })
      : speed === "standard"
        ? intl.formatMessage({ id: "chat.toolbar.speed.standard" })
        : speed;
  const title = intl.formatMessage({ id: "chat.toolbar.speed.tooltip" });

  return (
    <Select
      open={open}
      onOpenChange={onOpenChange}
      value={value}
      onValueChange={(next) => {
        if (values.includes(next)) onValueChange(next);
      }}
      disabled={disabled}
    >
      <ControlHintTooltip title={title}>
        <SelectTrigger
          variant="ghost"
          size="default"
          className="gap-1 rounded-md px-1.5 text-ui-base"
          aria-label={`${title}: ${value ? label(value) : title}`}
          data-chat-toolbar-popover-trigger="true"
          data-testid="chat-model-speed-trigger"
        >
          <GaugeIcon className="size-3.5" />
          <span className={labelClassName}>{value ? label(value) : title}</span>
        </SelectTrigger>
      </ControlHintTooltip>
      <SelectContent position="popper" side="top" align="start" sideOffset={4} collisionPadding={8}>
        {values.map((speed) => (
          <SelectItem key={speed} value={speed} data-testid={`chat-model-speed-${speed}`}>
            {label(speed)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
