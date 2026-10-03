import { isAbsolute, relative, resolve } from "node:path";
import type { LCodeAgentMcpServer } from "@lcode/shared";

type StdioServer = Extract<LCodeAgentMcpServer, { command: string }>;
const filesystemPackage = "@modelcontextprotocol/server-filesystem";

function rootArgumentIndex(server: LCodeAgentMcpServer): number | undefined {
  if (!("command" in server)) {
    if (server.name === "filesystem")
      throw new Error("Worktree filesystem MCP requires an explicit local directory scope");
    return undefined;
  }
  const index = server.args.findIndex((argument) => argument.includes(filesystemPackage));
  if (index < 0) {
    if (server.name === "filesystem")
      throw new Error("Unsupported filesystem MCP command in worktree execution");
    return undefined;
  }
  return index + 1;
}

export function filesystemMcpRoots(
  servers: LCodeAgentMcpServer[] | undefined,
  cwd: string,
): string[] {
  return (servers ?? []).flatMap((server) => {
    const index = rootArgumentIndex(server);
    return index === undefined
      ? []
      : (server as StdioServer).args.slice(index).map((path) => resolve(cwd, path));
  });
}

function descendant(root: string, path: string): string | undefined {
  const suffix = relative(root, path);
  return suffix === "" ||
    (!isAbsolute(suffix) &&
      suffix !== ".." &&
      !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    ? suffix
    : undefined;
}

export function remapFilesystemMcpServers(
  servers: LCodeAgentMcpServer[] | undefined,
  binding: { repositoryRoot: string; checkoutPath: string; workspacePath: string },
  originCwd: string,
): LCodeAgentMcpServer[] | undefined {
  return servers?.map((server) => {
    const index = rootArgumentIndex(server);
    if (index === undefined) return server;
    const stdio = server as StdioServer;
    const roots = stdio.args.slice(index).map((path) => {
      const absolute = resolve(originCwd, path);
      if (descendant(binding.checkoutPath, absolute) !== undefined) return absolute;
      const suffix = descendant(binding.repositoryRoot, absolute);
      // filesystem MCP 曾保留原目录甚至其祖先的写授权，仅改 Agent cwd 不能隔离工作树。
      if (suffix === undefined)
        throw new Error(`Filesystem MCP root is outside the worktree repository: ${path}`);
      return resolve(binding.checkoutPath, suffix);
    });
    if (!roots.includes(binding.workspacePath)) roots.push(binding.workspacePath);
    return { ...stdio, args: [...stdio.args.slice(0, index), ...new Set(roots)] };
  });
}
