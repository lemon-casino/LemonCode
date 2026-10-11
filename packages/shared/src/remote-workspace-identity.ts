// 远程 workspace identity 的统一解析工具（Workspace Identity 约束：构造与解析
// 必须复用统一工具，禁止业务代码手写拼接/拆解规则）。
// 构造与解析共用本文件的 buildRemoteWorkspaceIdentity —— 格式契约：
//   remote:ssh:<host>:<port>:<username>:<posixPath>
//   remote:wsl:<distro>[:<user>]:<posixPath>
//   remote:docker:<container>:<posixPath>
// path 段经 normalizeWorkspacePathForIdentity 归一（分隔符 → "/"，去收尾斜杠，
// 空 → "/"），因此恒以 "/" 开头；authority 各段不含 "/"（host 小写、port 数字、
// docker 容器名/wsl 发行版名的合法字符集均不含 ":" 与 "/"）。
// 消费方：CLI v4 createSession 的 workspaceId（远程 pane 里 workspaceKey =
// identity）需要还原出真实 workspacePath 作为会话 workingDirectory。
import type { RemoteTarget } from "./remoteTarget.js";

export type RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  /** 远端真实路径（posix 归一形态）。 */
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh" || value === "wsl" || value === "docker";
}

function normalizeWorkspacePathForIdentity(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

/**
 * 统一构造远程 workspace identity。Host、Main 和 UI 禁止自行拼接 authority；
 * `workspacePath` 只在这里归一后进入身份键，实际 IO 仍使用调用方原路径。
 */
export function buildRemoteWorkspaceIdentity(workspacePath: string, target: RemoteTarget): string {
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  switch (target.kind) {
    case "ssh":
      return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
    case "wsl": {
      const distro = target.distro?.trim() || "default";
      const user = target.user?.trim();
      return user
        ? `remote:wsl:${distro}:${user}:${normalizedPath}`
        : `remote:wsl:${distro}:${normalizedPath}`;
    }
    case "docker":
      return `remote:docker:${target.container}:${normalizedPath}`;
  }
}

/**
 * 解析远程 workspace identity；非法/非远程 identity 返回 null（调用方回落
 * 「按本地 workspacePath 处理」）。只提取 workspacePath——authority 细节
 * （host/port 等）对消费方（CLI 运行在远端机器上）无意义，不透出。
 */
export function parseRemoteWorkspaceIdentity(
  identity: string,
): ParsedRemoteWorkspaceIdentity | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    return null;
  }
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) {
    return null;
  }
  const kind = rest.slice(0, kindEnd);
  if (!isRemoteWorkspaceIdentityKind(kind)) {
    return null;
  }
  // 固定消费三个冒号会截断 IPv6 host，导致远端 createSession 把合法身份拒绝。
  // authority 不含斜杠，先以第一个 :/ 找到路径，再从右侧识别 SSH 的 port/user；
  // 保留已有 IPv6 identity 字面值，不迁移历史记录，也不截断路径中的冒号。
  const pathStart = rest.indexOf(":/", kindEnd + 1);
  if (pathStart < 0) return null;
  const authority = rest.slice(kindEnd + 1, pathStart);
  const validAuthority =
    kind === "ssh"
      ? /^[^/]+:[0-9]+:[^:/]+$/.test(authority)
      : kind === "wsl"
        ? /^[^:/]+(?::[^:/]+)?$/.test(authority)
        : /^[^:/]+$/.test(authority);
  if (!validAuthority) {
    return null;
  }
  const workspacePath = rest.slice(pathStart + 1);
  return { kind, workspacePath };
}

/** identity 是否是远程 workspace identity（可被 parseRemoteWorkspaceIdentity 解析）。 */
export function isRemoteWorkspaceIdentity(identity: string): boolean {
  return parseRemoteWorkspaceIdentity(identity) !== null;
}

/** 工作树只替换路径段，保留原 Environment authority，不在业务代码复制身份格式。 */
export function replaceRemoteWorkspaceIdentityPath(
  identity: string,
  workspacePath: string,
): string | null {
  const parsed = parseRemoteWorkspaceIdentity(identity);
  if (!parsed) return null;
  return `${identity.slice(0, identity.length - parsed.workspacePath.length)}${normalizeWorkspacePathForIdentity(workspacePath)}`;
}
