import {
  createGitReviewWorkspaceSnapshot,
  gitReviewWorkspaceKey,
  type GitReviewWorkspaceScope,
  type GitReviewWorkspaceSnapshot,
  type GitReviewWorkspaceUpdate,
} from "@lcode/shared";

/** 确定性 Host 边界桩；sharedHost 场景连接测试进程的实际持久 owner。 */
export function createReviewWorkspaceFixture() {
  const snapshots = new Map<string, GitReviewWorkspaceSnapshot>();
  const receipts = new Map<string, number>();
  const listeners = new Set<(snapshot: GitReviewWorkspaceSnapshot) => void>();
  const sharedHost = new URLSearchParams(location.search).get("sharedHost");
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(`${sharedHost}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error("fixture-host-offline");
    return response.json();
  };
  const read = (scope: GitReviewWorkspaceScope) =>
    snapshots.get(gitReviewWorkspaceKey(scope)) ?? createGitReviewWorkspaceSnapshot(scope);
  return {
    getReviewWorkspace: async (scope: GitReviewWorkspaceScope) =>
      sharedHost ? rpc("read", scope) : structuredClone(read(scope)),
    updateReviewWorkspace: async (command: GitReviewWorkspaceUpdate) => {
      if (sharedHost) return rpc("update", command);
      const snapshot = read(command.scope);
      if (receipts.has(command.commandId))
        return {
          status: "accepted" as const,
          commandRevision: receipts.get(command.commandId)!,
          snapshot: structuredClone(snapshot),
        };
      const fields = Object.keys(command.patch) as (keyof typeof command.patch)[];
      if (
        fields.some(
          (field) => command.expectedFieldRevisions[field] !== snapshot.fieldRevisions[field],
        )
      )
        return { status: "conflict" as const, snapshot: structuredClone(snapshot) };
      const next = {
        scope: command.scope,
        revision: snapshot.revision + 1,
        lastCommandId: command.commandId,
        data: { ...snapshot.data, ...command.patch },
        fieldRevisions: {
          ...snapshot.fieldRevisions,
          ...Object.fromEntries(fields.map((field) => [field, snapshot.revision + 1])),
        },
      };
      snapshots.set(gitReviewWorkspaceKey(command.scope), next);
      receipts.set(command.commandId, next.revision);
      listeners.forEach((listener) => listener(structuredClone(next)));
      return {
        status: "accepted" as const,
        commandRevision: next.revision,
        snapshot: structuredClone(next),
      };
    },
    onDynamicReviewWorkspace:
      (scope: GitReviewWorkspaceScope) =>
      (listener: (snapshot: GitReviewWorkspaceSnapshot) => void) => {
        if (sharedHost) {
          const source = new EventSource(
            `${sharedHost}/subscribe?scope=${encodeURIComponent(JSON.stringify(scope))}`,
          );
          source.onmessage = (event) => listener(JSON.parse(event.data));
          return { dispose: () => source.close() };
        }
        const receive = (snapshot: GitReviewWorkspaceSnapshot) => {
          if (gitReviewWorkspaceKey(snapshot.scope) === gitReviewWorkspaceKey(scope))
            listener(snapshot);
        };
        listeners.add(receive);
        return { dispose: () => listeners.delete(receive) };
      },
  };
}
