import { readWorkflowOrchestrationAdvice } from "@lcode/shared/lcode-protocol-v4";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

/** 只读的确认附注；共享 parser 验证有界形状与 raw.script 指纹，不修改脚本或审批。 */
export function WorkflowOrchestrationAdvice({ raw }: { raw: unknown }) {
  const { intl } = useLCodeIntl();
  const advice = readWorkflowOrchestrationAdvice(raw);
  if (advice.length === 0) return null;
  const location = (items: readonly { line: number; column: number }[]) =>
    items.map(({ line, column }) => `${line}:${column}`).join(", ");
  return (
    <aside
      className="min-w-0 space-y-1.5 rounded-lg bg-surface px-2.5 py-2 text-ui-sm text-foreground-subtle"
      data-testid="workflow-orchestration-advice"
    >
      <p className="font-medium text-foreground">
        {intl.formatMessage({ id: "chat.permission.workflow.advice.title" })}
      </p>
      <ul className="space-y-1.5">
        {advice.map((item) => (
          <li className="min-w-0 space-y-0.5" key={`${item.code}:${item.line}:${item.column}`}>
            <p className="break-words">
              <span className="font-mono tabular-nums">
                {item.line}:{item.column}
              </span>
              {" · "}
              {intl.formatMessage({ id: `chat.permission.workflow.advice.${item.code}` })}
            </p>
            <p className="break-words text-ui-xs text-foreground-subtlest">
              {intl.formatMessage(
                { id: "chat.permission.workflow.advice.locations" },
                {
                  waiting: location(item.waitingOn),
                  delayed: location(item.delayed),
                },
              )}
            </p>
          </li>
        ))}
      </ul>
      <p className="break-words">
        {intl.formatMessage({ id: "chat.permission.workflow.advice.caution" })}
      </p>
    </aside>
  );
}
