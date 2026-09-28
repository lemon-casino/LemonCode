import { existsSync } from "node:fs";
import { normalize } from "node:path";
import type { LCodeAgentMcpServer } from "@lcode/shared";

function normalizePathForCompare(value: string): string {
  const normalized = normalize(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isFilesystemServer(
  server: LCodeAgentMcpServer,
): server is Extract<LCodeAgentMcpServer, { command: string }> {
  return (
    "command" in server &&
    server.name === "filesystem" &&
    server.args.some((arg) => arg.includes("@modelcontextprotocol/server-filesystem"))
  );
}

export function appendWorkspaceToFilesystemMcpServers(
  mcpServers: LCodeAgentMcpServer[] | undefined,
  workspacePaths: string | readonly string[],
): LCodeAgentMcpServer[] | undefined {
  if (!mcpServers || mcpServers.length === 0) {
    return mcpServers;
  }

  const candidatePaths = typeof workspacePaths === "string" ? [workspacePaths] : workspacePaths;
  const existingWorkspacePaths = candidatePaths.reduce<string[]>((paths, candidatePath) => {
    const trimmedPath = candidatePath.trim();
    if (!trimmedPath || !existsSync(trimmedPath)) {
      return paths;
    }
    const pathKey = normalizePathForCompare(trimmedPath);
    if (!paths.some((path) => normalizePathForCompare(path) === pathKey)) {
      paths.push(trimmedPath);
    }
    return paths;
  }, []);
  if (existingWorkspacePaths.length === 0) {
    return mcpServers;
  }

  let changed = false;
  const nextServers = mcpServers.map((server) => {
    if (!isFilesystemServer(server)) {
      return server;
    }

    const existingServerPathKeys = new Set(server.args.map(normalizePathForCompare));
    const missingWorkspacePaths = existingWorkspacePaths.filter(
      (workspacePath) => !existingServerPathKeys.has(normalizePathForCompare(workspacePath)),
    );
    if (missingWorkspacePaths.length === 0) {
      return server;
    }

    changed = true;
    // 用户目录里的 filesystem MCP 可能只包含固定目录，不会自动允许当前项目目录，
    // 导致 agent 写主文件夹或附加源文件夹时报 "Access denied - path outside allowed
    // directories"。这里仅在本机路径存在时非持久化追加，避免远程 workspace
    // 被误注入本机 MCP。
    return {
      ...server,
      args: [...server.args, ...missingWorkspacePaths],
    };
  });

  return changed ? nextServers : mcpServers;
}
