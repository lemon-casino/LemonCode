import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveWorkspaceCheckpointAfterContent } from "../checkpoint-file-content.js";
import {
  parseWorkspaceCheckpointArtifact,
  type SessionStorePort,
  type WorkspaceId,
} from "@lcode/contracts";
import {
  lcodeWorkspaceFileMutationJournalParamsSchema,
  type GitFileMutationJournal,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

export async function readWorkspaceFileMutationJournal(input: {
  store: SessionStorePort;
  readArtifact: (uri: string) => Promise<string>;
  workspace: LCodeWorkspaceRef;
  paths: string[];
}): Promise<GitFileMutationJournal> {
  const result: GitFileMutationJournal = { complete: true, mutations: [] };
  if (!input.store.sessionEntries) return { complete: false, mutations: [] };
  const root = resolve(input.workspace.workspacePath);
  const paths = new Set(input.paths.map((path) => resolve(root, path)));
  for (const path of paths) {
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("审核文件越出 workspace。");
  }
  const identity = input.workspace.workspaceIdentity?.trim();
  const sessions = await input.store.listSessions({
    ...(identity
      ? { workspaceID: identity as WorkspaceId }
      : { workspaceID: null, directory: input.workspace.workspacePath }),
    includeArchived: true,
    limit: 101,
  });
  if (sessions.length > 100) result.complete = false;
  let bytes = 0,
    records = 0;
  for (const session of sessions.slice(0, 100)) {
    if (
      identity
        ? session.workspaceID !== identity
        : Boolean(session.workspaceID) || resolve(session.directory) !== root
    )
      continue;
    if (session.revert) {
      result.complete = false;
      continue;
    }
    const entries = await input.store.sessionEntries({
      sessionID: session.id,
      type: "runtime/workspace_checkpoint",
      limit: 501,
    });
    const rewinds = await input.store.sessionEntries({
      sessionID: session.id,
      type: "runtime/workspace_file_rewind",
      limit: 1,
    });
    if (rewinds.length > 0) {
      result.complete = false;
      continue;
    }
    for (const entry of entries) {
      if (++records > 500) return { ...result, complete: false };
      try {
        const payload = (entry.data as { payload?: { snapshotRef?: string } }).payload;
        if (!payload?.snapshotRef) throw new Error("Missing checkpoint reference");
        const raw = await input.readArtifact(payload.snapshotRef);
        bytes += Buffer.byteLength(raw);
        if (bytes > 2_097_152) return { ...result, complete: false };
        const artifact = parseWorkspaceCheckpointArtifact(JSON.parse(raw));
        // 历史回退快照不是完整的归属账本，只有新版本明确记录的内置文件工具来源可自动拆分。
        if (artifact.provenance !== "builtin_file_tool") continue;
        for (const file of artifact.files) {
          const path = resolve(root, file.path);
          if (!paths.has(path)) continue;
          const afterContent = resolveWorkspaceCheckpointAfterContent(file);
          if (afterContent === undefined || !Number.isFinite(Date.parse(artifact.createdAt))) {
            result.complete = false;
            continue;
          }
          result.mutations.push({
            id: `${session.id}:${artifact.toolCallId}:${path}`,
            sessionId: String(session.id),
            ...(session.title ? { sessionTitle: session.title } : {}),
            path,
            beforeContent: file.beforeContent,
            afterContent,
            toolName: artifact.toolName,
            createdAt: Date.parse(artifact.createdAt),
          });
          if (result.mutations.length >= 500) return { ...result, complete: false };
        }
      } catch {
        result.complete = false;
      }
    }
  }
  return result;
}

export async function workspaceFileMutationJournal(
  context: LCodeProtocolAgentServerContext,
  params: unknown,
): Promise<GitFileMutationJournal> {
  const parsed = parseParams(lcodeWorkspaceFileMutationJournalParamsSchema, params);
  if (
    parsed.workspace.workspaceKey !==
    (parsed.workspace.workspaceIdentity?.trim() || parsed.workspace.workspacePath)
  )
    throw new Error("Workspace identity mismatch");
  if (!context.deps.sessionStore || !context.deps.readWorkspaceCheckpointArtifact)
    return { complete: false, mutations: [] };
  return readWorkspaceFileMutationJournal({
    ...parsed,
    store: context.deps.sessionStore,
    readArtifact: context.deps.readWorkspaceCheckpointArtifact,
  });
}
