import {
  parseRemoteWorkspaceIdentity,
  type LCodeWorkspaceRef,
} from "@lcode/shared";

export function buildWorkspaceRef(input: {
  workspaceIdentity?: string;
  workspacePath: string;
  /** 托管运行环境引用（spec §8.1，M4 P4-01）：fork 复制 binding entry 时不丢字段。 */
  environmentRef?: LCodeWorkspaceRef["environmentRef"];
}): LCodeWorkspaceRef {
  const workspaceIdentity = input.workspaceIdentity?.trim() || undefined;
  return {
    workspaceIdentity,
    workspaceKey: workspaceIdentity ?? input.workspacePath,
    workspacePath: input.workspacePath,
    ...(input.environmentRef ? { environmentRef: input.environmentRef } : {}),
  };
}

export function originWorkspaceRef(workspace: LCodeWorkspaceRef): LCodeWorkspaceRef {
  return workspace.originWorkspacePath
    ? buildWorkspaceRef({
        workspacePath: workspace.originWorkspacePath,
        workspaceIdentity: workspace.originWorkspaceIdentity,
      })
    : workspace;
}

/**
 * 将 V4 workspaceId 的本地路径/远程 identity 双形态统一还原为 workspace ref。
 */
export function resolveWorkspaceRefFromId(workspaceId: string): LCodeWorkspaceRef {
  const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
  if (!parsedRemote) {
    // 非法 remote identity 若继续按本地路径处理，会再次把 identity 写入
    // directory/path。remote 命名空间必须 fail-closed，本地路径仍保留原 fallback。
    if (workspaceId.startsWith("remote:")) {
      throw new Error(`Invalid remote workspace identity: ${workspaceId}`);
    }
    return buildWorkspaceRef({ workspacePath: workspaceId });
  }

  // 带显式 user 的 WSL identity 以前解析失败后会落入本地路径分支，
  // 使完整 identity 被当成 workingDirectory。这里统一通过 shared parser 拆分身份与路径。
  return buildWorkspaceRef({
    workspaceIdentity: workspaceId,
    workspacePath: parsedRemote.workspacePath,
  });
}
