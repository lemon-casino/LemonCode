import type { PermissionDecisionResult } from "../../permission/service.js";
import {
  resolveContainedMemoryFilePath,
  resolveSafeMemoryFilePath,
} from "../../memory/memory-file-path.js";

interface MemoryFileTargetInput {
  executionInput: unknown;
  memoryRoot?: string;
  toolName: string;
  workingDirectory: string;
  workspaceRoot: string;
}

interface MemoryFilePermissionInput extends MemoryFileTargetInput {
  decision: PermissionDecisionResult;
}

export function applyMemoryFilePermission(
  input: MemoryFilePermissionInput,
): PermissionDecisionResult {
  const target = resolveMemoryFileTarget(input);
  if (!target || !input.memoryRoot) return input.decision;

  if (
    !target.endsWith(".md") ||
    resolveSafeMemoryFilePath({
      filePath: target,
      rootDir: input.memoryRoot,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    }) === undefined
  ) {
    return input.decision;
  }
  if (preservesExistingPermissionDecision(input.decision)) return input.decision;

  return {
    ...input.decision,
    allowed: true,
    decision: "allow",
    escalated: false,
    reason: "Memory Markdown writes are allowed",
    ruleId: "memory.file.markdown",
  };
}

export function targetsMemoryFile(input: MemoryFileTargetInput): boolean {
  return resolveMemoryFileTarget(input) !== undefined;
}

function resolveMemoryFileTarget(
  input: MemoryFileTargetInput,
): string | undefined {
  if (input.toolName !== "Write" && input.toolName !== "Edit") return undefined;
  if (!input.memoryRoot) return undefined;

  const requestedPath = filePathFromInput(input.executionInput);
  if (!requestedPath) return undefined;
  return resolveContainedMemoryFilePath({
    filePath: requestedPath,
    rootDir: input.memoryRoot,
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  });
}

function filePathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const filePath = (input as Record<string, unknown>).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function preservesExistingPermissionDecision(decision: PermissionDecisionResult): boolean {
  if (decision.decision === "deny") {
    return decision.ruleId !== "mode.plan.nonReadOnly";
  }
  // alwaysAsk 是工具自报的"任何情况都要问"，这里不能把它放行掉。今天走不到这条分支
  // （只有 Write/Edit 会命中 memory 目标，二者都没声明 alwaysAsk），但一旦有人给它们加上，
  // 少了这个判断就会出现"memory 文件让模式无关的确认静默消失"——正是本旗标要防的事。
  if (decision.alwaysAsk) return true;
  return (
    decision.decision === "ask" &&
    (decision.ruleId === "rule.project.ask" || decision.ruleId === "hook.PreToolUse.ask")
  );
}
