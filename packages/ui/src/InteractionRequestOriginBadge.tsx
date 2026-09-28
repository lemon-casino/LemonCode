import type { LCodeInteractionRequestOrigin } from "@lcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: LCodeInteractionRequestOrigin;
}) {
  const { intl } = useLCodeIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  const label = intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  const title = origin.agentType
    ? intl.formatMessage(
        { id: "chat.interactionOrigin.subagent.title" },
        { agentType: origin.agentType },
      )
    : label;

  return (
    <Badge
      variant="outline"
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn("max-w-40 align-baseline text-ui-base truncate", className)}
    >
      {label}
    </Badge>
  );
}
