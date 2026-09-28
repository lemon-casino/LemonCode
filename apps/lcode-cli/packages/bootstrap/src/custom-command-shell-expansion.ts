import { basename, dirname } from "node:path";
import {
  type CustomCommandContent,
  type HookPluginContext,
  type ExecutionPort,
  type ExecutionResult,
  type TraceContext,
} from "@lcode/contracts";

const DEFAULT_SHELL_EXPANSION_TIMEOUT_MS = 30_000;
const DEFAULT_SHELL_EXPANSION_OUTPUT_BYTES = 128 * 1024;

const INLINE_SHELL_PATTERN = /!`([^`]*)`/gu;
const FENCED_SHELL_PATTERN = /```!\s*\r?\n?([\s\S]*?)```/gu;
const SHELL_CONTEXT_VARIABLE_PATTERN =
  /\$\{(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|LCODE_PLUGIN_DATA|LCODE_PLUGIN_ROOT|LCODE_PROJECT_DIR|LCODE_SESSION_ID|LCODE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)\}/gu;

interface ShellExpansionMatch {
  command: string;
  end: number;
  start: number;
  type: "fenced" | "inline";
}

export async function expandCustomCommandShellSyntax(input: {
  command: CustomCommandContent;
  content: string;
  executionPort: ExecutionPort;
  sessionId?: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  workingDirectory: string;
}): Promise<string> {
  let cursor = 0;
  let output = "";

  for (const match of collectShellExpansionMatches(input.content)) {
    output += input.content.slice(cursor, match.start);
    output += await runShellExpansion({
      ...input,
      shellCommand: match.command,
      type: match.type,
    });
    cursor = match.end;
  }

  output += input.content.slice(cursor);
  return output;
}

function collectShellExpansionMatches(content: string): ShellExpansionMatch[] {
  const matches: ShellExpansionMatch[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    INLINE_SHELL_PATTERN.lastIndex = cursor;
    FENCED_SHELL_PATTERN.lastIndex = cursor;

    const inline = INLINE_SHELL_PATTERN.exec(content);
    const fenced = FENCED_SHELL_PATTERN.exec(content);
    const next = pickNextMatch(inline, fenced);
    if (!next) break;

    matches.push(next);
    cursor = next.end;
  }

  INLINE_SHELL_PATTERN.lastIndex = 0;
  FENCED_SHELL_PATTERN.lastIndex = 0;
  return matches;
}

function pickNextMatch(
  inline: RegExpExecArray | null,
  fenced: RegExpExecArray | null,
): ShellExpansionMatch | null {
  if (!inline && !fenced) return null;
  if (fenced && (!inline || fenced.index <= inline.index)) {
    return {
      command: normalizeFencedShellCommand(fenced[1] ?? ""),
      end: fenced.index + fenced[0].length,
      start: fenced.index,
      type: "fenced",
    };
  }
  if (!inline) return null;
  return {
    command: (inline[1] ?? "").trim(),
    end: inline.index + inline[0].length,
    start: inline.index,
    type: "inline",
  };
}

function normalizeFencedShellCommand(command: string): string {
  return command.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "").trim();
}

async function runShellExpansion(input: {
  command: CustomCommandContent;
  env?: NodeJS.ProcessEnv;
  executionPort: ExecutionPort;
  sessionId?: string;
  shellCommand: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  type: "fenced" | "inline";
  workingDirectory: string;
}): Promise<string> {
  if (input.shellCommand.length === 0) return "";
  const plugin = input.command.metadata.plugin ?? inferPluginContext(input.command);
  assertShellExpansionContextAvailable({
    command: input.command,
    plugin,
    sessionId: input.sessionId,
    shellCommand: input.shellCommand,
  });

  const result = await input.executionPort.run(
    {
      command: {
        mode: "shell",
        command: input.shellCommand,
      },
      cwd: input.workingDirectory,
      env: createShellExpansionEnv({
        plugin,
        sessionId: input.sessionId,
        workingDirectory: input.workingDirectory,
      }),
      outputLimit: {
        maxBufferBytes: DEFAULT_SHELL_EXPANSION_OUTPUT_BYTES,
        maxInlineBytes: DEFAULT_SHELL_EXPANSION_OUTPUT_BYTES,
        persistOutput: "none",
      },
      timeoutMs: DEFAULT_SHELL_EXPANSION_TIMEOUT_MS,
      ...(input.traceContext
        ? {
            trace: {
              ...input.traceContext,
              attributes: {
                ...input.traceContext.attributes,
                customCommandName: input.command.metadata.name,
                customCommandShellExpansion: input.type,
              },
            },
          }
        : {}),
    },
    { signal: input.signal },
  );

  if (result.status === "completed" && (result.exitCode ?? 0) === 0) {
    return result.stdout.text.trimEnd();
  }

  throw new Error(formatShellExpansionError(input.command, input.shellCommand, result));
}

function createShellExpansionEnv(input: {
  plugin: HookPluginContext | undefined;
  sessionId: string | undefined;
  workingDirectory: string;
}) {
  const set: Record<string, string> = {};
  set.CLAUDE_PROJECT_DIR = input.workingDirectory;
  set.LCODE_PROJECT_DIR = input.workingDirectory;
  // 旧名兼容：已文档化的 ZCODE_* 插件变量继续注入同一取值（旧插件契约）。
  set.ZCODE_PROJECT_DIR = input.workingDirectory;
  if (input.sessionId) {
    set.CLAUDE_CODE_SESSION_ID = input.sessionId;
    set.CLAUDE_SESSION_ID = input.sessionId;
    set.LCODE_SESSION_ID = input.sessionId;
    set.ZCODE_SESSION_ID = input.sessionId;
  }
  if (input.plugin) {
    set.CLAUDE_PLUGIN_DATA = input.plugin.dataPath;
    set.CLAUDE_PLUGIN_ROOT = input.plugin.rootPath;
    set.LCODE_PLUGIN_DATA = input.plugin.dataPath;
    set.ZCODE_PLUGIN_DATA = input.plugin.dataPath;
    set.LCODE_PLUGIN_ID = input.plugin.id;
    set.LCODE_PLUGIN_NAME = input.plugin.name;
    set.LCODE_PLUGIN_ROOT = input.plugin.rootPath;
    set.ZCODE_PLUGIN_ROOT = input.plugin.rootPath;
  }
  return Object.keys(set).length > 0 ? { set } : undefined;
}

function assertShellExpansionContextAvailable(input: {
  command: CustomCommandContent;
  plugin: HookPluginContext | undefined;
  sessionId: string | undefined;
  shellCommand: string;
}): void {
  for (const match of input.shellCommand.matchAll(SHELL_CONTEXT_VARIABLE_PATTERN)) {
    const name = match[1];
    if (!name) continue;
    if (name === "CLAUDE_SKILL_DIR" || name === "LCODE_SKILL_DIR" || name === "ZCODE_SKILL_DIR") {
      throw new Error(
        `Custom command /${input.command.metadata.name} variable requires a skill context: ${name}`,
      );
    }
    if (
      !input.sessionId &&
      (name === "CLAUDE_CODE_SESSION_ID" ||
        name === "CLAUDE_SESSION_ID" ||
        name === "LCODE_SESSION_ID" ||
        name === "ZCODE_SESSION_ID")
    ) {
      throw new Error(
        `Custom command /${input.command.metadata.name} variable requires a runtime session context: ${name}`,
      );
    }
    if (
      !input.plugin &&
      (name === "CLAUDE_PLUGIN_DATA" ||
        name === "CLAUDE_PLUGIN_ROOT" ||
        name === "LCODE_PLUGIN_DATA" ||
        name === "LCODE_PLUGIN_ROOT" ||
        name === "ZCODE_PLUGIN_DATA" ||
        name === "ZCODE_PLUGIN_ROOT")
    ) {
      throw new Error(
        `Custom command /${input.command.metadata.name} variable requires a plugin context: ${name}`,
      );
    }
  }
  SHELL_CONTEXT_VARIABLE_PATTERN.lastIndex = 0;
}

function inferPluginContext(command: CustomCommandContent): HookPluginContext | undefined {
  if (command.metadata.source !== "plugin") return undefined;
  if (basename(command.metadata.rootPath) !== "commands") return undefined;
  const rootPath = dirname(command.metadata.rootPath);
  return {
    dataPath: rootPath,
    id: basename(rootPath),
    name: basename(rootPath),
    rootPath,
  };
}

function formatShellExpansionError(
  command: CustomCommandContent,
  shellCommand: string,
  result: ExecutionResult,
): string {
  const details =
    result.error?.message ||
    trimPreview(result.stderr.text) ||
    trimPreview(result.stdout.text) ||
    `status=${result.status}`;
  return [
    `Custom command /${command.metadata.name} shell expansion failed.`,
    `Command: ${shellCommand}`,
    `Exit: ${result.exitCode ?? result.status}`,
    `Details: ${details}`,
  ].join("\n");
}

function trimPreview(value: string): string {
  return value.trim().slice(0, 2_000);
}
