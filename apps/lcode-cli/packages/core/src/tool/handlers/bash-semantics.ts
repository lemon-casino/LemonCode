import type { ExecutionResult } from "@lcode/contracts";
import { analyzeBashCommand, isBashCommandPermissionSafe } from "./bash-command-parser.js";
import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
  isSedInPlaceOption,
} from "./bash-readonly-policy.js";
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(["", ":", "echo", "false", "printf", "true"]);
const BASH_SILENT_COMMANDS = new Set([
  "cd",
  "chgrp",
  "chmod",
  "chown",
  "cp",
  "export",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "unset",
  "wait",
]);
const SEMANTIC_NON_ERROR_MESSAGES = new Set([
  "Condition is false",
  "Files differ",
  "No matches found",
  "Some directories were inaccessible",
]);
const SEMANTIC_NO_MATCH_COMMANDS = new Set(["egrep", "fgrep", "grep", "rg"]);

export function isRuntimeReadOnlyBashCommand(
  command: string,
  context?: BashReadonlyRuntimeContext,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length === 0) return false;
  if (analysisContainsGitAndDirectoryChange(analysis.commands)) return false;
  if (analysisContainsGitCommand(analysis.commands) && isGitRuntimeContextUnsafe(context))
    return false;

  let hasReadOnlyCommand = false;

  for (const commandPart of analysis.commands) {
    if (hasKnownBashWriteOption(commandPart)) return false;

    const policyResult = evaluateBashReadonlyPolicy(commandPart);
    if (policyResult === false) return false;
    if (policyResult === true) {
      hasReadOnlyCommand = true;
      continue;
    }

    return false;
  }

  return hasReadOnlyCommand;
}

export function isSedInPlaceBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors) return false;
  return analysis.commands.some(
    (commandPart) => commandPart.name === "sed" && commandPart.argv.some(isSedInPlaceOption),
  );
}

export function isSilentBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || analysis.hasDynamicWords)
    return false;
  if (analysis.commands.length === 0) return false;

  let hasNonFallbackCommand = false;

  for (const commandPart of analysis.commands) {
    const commandName = commandPart.name;
    if (!commandName) continue;
    if (commandPart.operatorBefore === "||" && BASH_SEMANTIC_NEUTRAL_COMMANDS.has(commandName)) {
      continue;
    }

    hasNonFallbackCommand = true;
    if (!BASH_SILENT_COMMANDS.has(commandName)) return false;
  }

  return hasNonFallbackCommand;
}

export function interpretBashReturnCode(
  command: string,
  result: Pick<ExecutionResult, "error" | "exitCode" | "signal" | "status">,
): string | undefined {
  if (result.error?.type === "output_limit") {
    return "Command stopped because output exceeded the configured limit";
  }
  if (result.status === "timed_out") return "Command timed out";
  if (result.status === "cancelled") return "Command was cancelled";
  if (result.status === "spawn_error") return "Command failed to start";
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    const semantic = semanticNonErrorExit(command, result.exitCode);
    return semantic ?? `Command exited with code ${result.exitCode}`;
  }
  if (result.signal) return `Command exited due to signal ${result.signal}`;
  return undefined;
}

function isSemanticNonErrorInterpretation(message: string | undefined): boolean {
  return message !== undefined && SEMANTIC_NON_ERROR_MESSAGES.has(message);
}

export function isBashProviderErrorStatus(output: {
  exitCode?: unknown;
  returnCodeInterpretation?: unknown;
  status?: unknown;
}): boolean {
  if (output.status !== "failed") return false;
  if (typeof output.exitCode !== "number" || output.exitCode === 0) return false;
  return !isSemanticNonErrorInterpretation(
    typeof output.returnCodeInterpretation === "string"
      ? output.returnCodeInterpretation
      : undefined,
  );
}

function semanticNonErrorExit(command: string, exitCode: number): string | undefined {
  if (exitCode !== 1) return undefined;
  const commandName = statusCommandNameForExitOne(command);
  return commandName === undefined ? undefined : semanticExitOneInterpretation(commandName);
}

function statusCommandNameForExitOne(command: string): string | undefined {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) return undefined;
  const statusCommand = analysis.commands.at(-1);
  if (statusCommand === undefined) return undefined;

  // 不能因为命令行前面出现过 rg/grep，就把后续 test/exit 的 1 误判成 No matches found。
  if (statusCommand.name === "git") {
    const gitSubcommand = gitSemanticSubcommandName(statusCommand.argv);
    if (gitSubcommand === "grep") return "grep";
    if (gitSubcommand === "diff") return "diff";
  }
  return statusCommand.name;
}

function semanticExitOneInterpretation(commandName: string): string | undefined {
  if (SEMANTIC_NO_MATCH_COMMANDS.has(commandName)) return "No matches found";
  if (commandName === "find") return "Some directories were inaccessible";
  if (commandName === "diff") return "Files differ";
  if (commandName === "test" || commandName === "[") return "Condition is false";
  return undefined;
}

function gitSemanticSubcommandName(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      if (arg === "-C" || arg === "-c") index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}
