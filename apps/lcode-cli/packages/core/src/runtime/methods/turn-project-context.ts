import { formatProjectContextSnapshot, projectContextSnapshotSchema } from "@lcode/shared";
import type { TurnInputIntentMetadata } from "@lcode/contracts";
import type { TraceContext } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { prepareProjectFilesystemMcp } from "./project-filesystem-mcp.js";

/** 在原生工具执行前使用 admission 固定的真实目录；不读取新项目版本，不更换工作目录。 */
export async function prepareTurnProjectContext(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  signal: AbortSignal,
  traceContext?: TraceContext,
): Promise<void> {
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const previousScope = entries.some((entry) => entry.metadata?.source === "project_scope");
  if (previousScope)
    runtime.messageHistory.replaceMessages(
      entries.filter((entry) => entry.metadata?.source !== "project_scope"),
    );
  if (!intent?.projectContext) {
    if (previousScope && traceContext)
      await prepareProjectFilesystemMcp(runtime, undefined, traceContext);
    return;
  }
  const snapshot = projectContextSnapshotSchema.parse(intent.projectContext);
  if (!runtime.fileSystemPort)
    throw new Error("Project context requires the filesystem capability");
  for (const member of snapshot.members) {
    if (signal.aborted) throw new Error("Project context preparation cancelled");
    const status = await runtime.fileSystemPort.stat(
      { path: member.workspacePath, trace: traceContext },
      { signal },
    );
    if (status.kind !== "directory")
      throw new Error(`${member.workspacePath}: project member is not a directory`);
  }
  if (traceContext) await prepareProjectFilesystemMcp(runtime, snapshot, traceContext);
  runtime.messageHistory.addUser(formatProjectContextSnapshot(snapshot), {
    source: "project_scope",
  });
}
