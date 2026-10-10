// Bash tool declaration and runtime permission policy.
import {
  BashInputJsonSchema,
  BashInputSchema,
  BashOutputJsonSchema,
  BashOutputSchema,
} from "@lcode/contracts";
import {
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  type BashTimeoutPolicy,
} from "../bash-timeout-policy.js";
import type {
  ToolEntry,
  ToolHandler,
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { resolveBashPermissionRulePolicy } from "./bash-command-permission-policy.js";
import { readStringProperty } from "./bash-metadata.js";
import { formatBashModelContent, formatPersistedBashModelContent } from "./bash-model-content.js";
import { createBashProviderDescription } from "./bash-prompt.js";
import { isRuntimeReadOnlyBashCommand } from "./bash-semantics.js";
import { supportsPosixCommandAnalysis } from "./shell-command-analysis.js";
import { executeBashHandler, MAX_INLINE_OUTPUT_BYTES } from "./bash-execution.js";

export {
  getBashActivityDescription,
  getBashAutoClassifierInput,
  getBashDescription,
  getBashToolUseSummary,
  getBashUserFacingName,
} from "./bash-metadata.js";

const BASH_PROVIDER_DESCRIPTION = createBashProviderDescription({
  defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
  maxTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.maxTimeoutMs,
});

function resolveBashPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const parsed = BashInputSchema.safeParse(input);
  if (parsed.success && parsed.data.keep_alive_after_task === true) {
    // 模型的保留参数只是请求，不是用户授权；不能被完全访问或只读 Bash 判定静默放行。
    return {
      needsApproval: true,
      permission: {
        needsApproval: true,
        alwaysAsk: true,
        approvalSource: "user",
        askOptions: { allowAlways: false },
        reason:
          "Keep this preview running after task completion? This approval applies only to this command.",
      },
    };
  }
  const command = readStringProperty(input, "command");
  if (!supportsPosixCommandAnalysis(context?.bashShellSelection)) return undefined;
  if (!command || !isRuntimeReadOnlyBashCommand(command, context)) return undefined;
  return {
    destructive: false,
    needsApproval: false,
    readOnly: true,
    riskLevel: "low" as const,
    sideEffectScope: "none" as const,
    permission: {
      needsApproval: false,
      riskLevel: "low" as const,
      sideEffectScope: "none" as const,
    },
  };
}

const bashHandler: ToolHandler = (input, context) =>
  executeBashHandler(input, context, DEFAULT_BASH_TIMEOUT_POLICY);

function createBashHandler(timeoutPolicy: BashTimeoutPolicy): ToolHandler {
  return (input, context) => executeBashHandler(input, context, timeoutPolicy);
}

export const bashToolEntry: ToolEntry = {
  capability: "Execute platform shell commands through the execution adapter",
  metadata: {
    name: "Bash",
    description: BASH_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
    maxOutputBytes: 10_000_000,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
  },
  formatModelContent: formatBashModelContent,
  formatPersistedModelContent: formatPersistedBashModelContent,
  handler: bashHandler,
  resolveTimeoutBudgetMs: createBashTimeoutBudgetResolver(DEFAULT_BASH_TIMEOUT_POLICY),
  resolvePermissionCapability: resolveBashPermissionCapability,
  resolvePermissionRulePolicy: resolveBashPermissionRulePolicy,
  inputSchema: BashInputJsonSchema,
  outputSchema: BashOutputJsonSchema,
  runtimeInputSchema: BashInputSchema,
  runtimeOutputSchema: BashOutputSchema,
  permission: {
    permission: "bash",
    reason: "Bash can run subprocesses and may affect workspace, git, network, or system state",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["command"],
    alwaysAllowPatternSources: ["command"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
    maxModelBytes: 30_000,
    strategy: "artifact",
    preview: {
      maxBytes: 30_000,
      direction: "tail",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
    maxMs: DEFAULT_BASH_TIMEOUT_POLICY.maxTimeoutMs,
    allowCallOverride: true,
    cleanupGraceMs: 6_000,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Bash was cancelled and the child process was asked to stop",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export function createBashToolEntry(
  options: {
    bashTimeoutPolicy?: BashTimeoutPolicy;
    embeddedSearchEnabled?: boolean;
  } = {},
): ToolEntry {
  const timeoutPolicy = options.bashTimeoutPolicy ?? DEFAULT_BASH_TIMEOUT_POLICY;
  return {
    ...bashToolEntry,
    handler: createBashHandler(timeoutPolicy),
    inputSchema: createBashInputJsonSchema(timeoutPolicy),
    resolveTimeoutBudgetMs: createBashTimeoutBudgetResolver(timeoutPolicy),
    metadata: {
      ...bashToolEntry.metadata,
      description: createBashProviderDescription({
        defaultTimeoutMs: timeoutPolicy.defaultTimeoutMs,
        embeddedSearchEnabled: options.embeddedSearchEnabled,
        maxTimeoutMs: timeoutPolicy.maxTimeoutMs,
      }),
      timeoutMs: timeoutPolicy.defaultTimeoutMs,
    },
    timeout: {
      defaultMs: timeoutPolicy.defaultTimeoutMs,
      maxMs: timeoutPolicy.maxTimeoutMs,
      allowCallOverride: true,
      cleanupGraceMs: 6_000,
    },
  };
}

function createBashTimeoutBudgetResolver(
  timeoutPolicy: BashTimeoutPolicy,
): NonNullable<ToolEntry["resolveTimeoutBudgetMs"]> {
  return (input) => {
    const parsed = BashInputSchema.safeParse(input);
    // 旧 watchdog 直接读取 raw timeout，导致 0 被压成 1ms，且字符串数字绕过
    // Bash policy。这里和 handler 共用 timeout || default / max 解析后再加 cleanup grace。
    return resolveBashTimeoutMs(parsed.success ? parsed.data.timeout : undefined, timeoutPolicy);
  };
}

function createBashInputJsonSchema(timeoutPolicy: BashTimeoutPolicy): Record<string, unknown> {
  const schema = BashInputJsonSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const timeoutProperty = properties?.timeout as Record<string, unknown> | undefined;
  if (!properties || !timeoutProperty) return schema;

  return {
    ...schema,
    properties: {
      ...properties,
      timeout: {
        ...timeoutProperty,
        description: `Optional timeout in milliseconds (max ${timeoutPolicy.maxTimeoutMs})`,
      },
    },
  };
}
