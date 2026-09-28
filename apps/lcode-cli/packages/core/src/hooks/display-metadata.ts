import type { HookConfig, HookExecutionDescriptor } from "@lcode/contracts";

const SENSITIVE_KEY =
  "(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret|token)";
const SENSITIVE_IDENTIFIER = `(?:[A-Za-z0-9]+[_-])*${SENSITIVE_KEY}(?:[_-][A-Za-z0-9]+)*`;
const MASK = "••••";

export function createHookExecutionDescriptor(
  hook: HookConfig,
  timeoutMs: number,
  expandDisplayValue: (value: string) => string = (value) => value,
): HookExecutionDescriptor {
  const commandDisplay =
    hook.type === "process"
      ? [hook.command, ...(hook.args ?? [])].map(expandDisplayValue).map(quoteCommandPart).join(" ")
      : expandDisplayValue(hook.command);
  const plugin = hook.plugin;
  const sourceKind = plugin ? "plugin" : (hook.source?.kind ?? "internal");
  return {
    clientVisible: sourceKind !== "internal",
    commandDisplay: sanitizeHookDisplayText(commandDisplay),
    executionMode: hook.type === "command" && hook.async === true ? "background" : "foreground",
    executionType: hook.type,
    ...(plugin?.id ? { pluginId: plugin.id } : {}),
    ...(plugin?.name ? { pluginName: plugin.name } : {}),
    sourceKind,
    ...(plugin?.sourcePath || hook.source?.path
      ? { sourcePath: plugin?.sourcePath ?? hook.source?.path }
      : {}),
    ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
    timeoutMs,
  };
}

export function sanitizeHookDisplayText(value: string): string {
  if (!value) return value;
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu, `$1${MASK}:${MASK}@`)
    .replace(
      /(authorization\s*:\s*(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu,
      `$1${MASK}`,
    )
    .replace(
      new RegExp(`([?&](?:authorization|${SENSITIVE_IDENTIFIER})=)[^&\\s"']+`, "giu"),
      `$1${MASK}`,
    )
    .replace(/(\bauthorization\b\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)/giu, `$1${MASK}`)
    .replace(
      new RegExp(
        `((?:"${SENSITIVE_IDENTIFIER}"|'${SENSITIVE_IDENTIFIER}')\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`,
        "giu",
      ),
      `$1${MASK}`,
    )
    .replace(
      new RegExp(
        `(^|[^A-Za-z0-9_])(${SENSITIVE_IDENTIFIER}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`,
        "gimu",
      ),
      `$1$2${MASK}`,
    )
    .replace(
      new RegExp(`((?:--)?${SENSITIVE_IDENTIFIER})(\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "giu"),
      `$1$2${MASK}`,
    );
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}
