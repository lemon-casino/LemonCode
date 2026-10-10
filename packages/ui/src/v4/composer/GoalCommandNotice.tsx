import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { parseV4VisibleSlashCommand } from "@/v4/slashCommands.js";

export function GoalCommandNotice({ text }: { text: string }) {
  const { intl } = useLCodeIntl();
  const command = parseV4VisibleSlashCommand(text);
  if (command?.kind !== "unsupportedGoal" || command.action !== "strict") return null;
  return (
    <p role="alert" className="px-3 text-ui-base text-destructive">
      {intl.formatMessage({ id: "chat.goal.strictCliOnly" })}
    </p>
  );
}
