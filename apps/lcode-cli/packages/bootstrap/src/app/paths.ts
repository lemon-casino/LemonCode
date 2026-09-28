import { basename, join } from "node:path";
import { createProjectId, type ProjectId } from "@lcode/contracts";
import { resolveProjectMemoryRoot } from "@lcode/core";

export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

export function getPluginStorageRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "plugins");
}

export function getModelIoDir(cliStorageRoot: string, isDevelopment: boolean): string {
  return join(cliStorageRoot, isDevelopment ? "debug" : "rollout");
}

export function getProjectMemoryRoot(
  cliStorageRoot: string,
  workingDirectory: string,
  workspaceIdentity?: string,
): string {
  return resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity,
    workspacePath: workingDirectory,
  });
}

export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default",
  );
}
