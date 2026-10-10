import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { readComposerCapsuleRefs } from "./contextCapsuleRefs.js";

export function ContextCapsuleNotice({
  text,
  existingSession,
}: {
  text: string;
  existingSession: boolean;
}) {
  const { intl } = useLCodeIntl();
  let count: number;
  try {
    count = readComposerCapsuleRefs(text).length;
  } catch {
    return (
      <p role="alert" className="px-3 text-ui-base text-destructive">
        {intl.formatMessage({ id: "taskList.handoff.capsuleLimit" })}
      </p>
    );
  }
  if (count && !existingSession)
    return (
      <p role="alert" className="px-3 text-ui-base text-destructive">
        {intl.formatMessage({ id: "taskList.handoff.existingRequired" })}
      </p>
    );
  return count ? (
    <p data-testid="capsule-reference-notice" className="px-3 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "taskList.handoff.capsuleCount" }, { count })}
    </p>
  ) : null;
}
