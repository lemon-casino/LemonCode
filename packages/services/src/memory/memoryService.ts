import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveProjectMemoryRoot, withFileLock } from "@lcode/shared/node";
import type { ISettingService } from "../setting/setting.js";
import type { IMemoryService, ProjectMemoryWorkspaceSummary } from "./memory.js";
import { readProjectMemoryFileFromStableHandle } from "./projectMemoryStableRead.js";
import {
  isMemoryNotFound,
  listMemoryFiles,
  requireMemoryDirectoryChain,
  requireMemoryFile,
} from "./projectMemoryCatalog.js";
import { getLCodeDataRootDir } from "../paths.js";
import {
  listLocalMemoryWorkspaces,
  prepareLocalMemoryStorage,
  type MemoryWorktreeService,
} from "./localMemoryWorkspaces.js";

interface MemoryServiceOptions {
  settingService?: Pick<ISettingService, "get" | "update">;
  worktreeService?: MemoryWorktreeService;
}
interface MemoryScope {
  id: string;
  label: string;
  memoryRoot: string;
  storageLocation: "profile" | "workspace";
}

function cliStorageRoot(): string {
  return join(getLCodeDataRootDir(), "cli");
}

export function createMemoryService(options: MemoryServiceOptions = {}): IMemoryService {
  async function scopes(): Promise<MemoryScope[]> {
    const result: MemoryScope[] = [];
    const workspaces = options.settingService
      ? await listLocalMemoryWorkspaces(await options.settingService.get(), options.worktreeService)
      : [];
    const profileLabels = new Map<string, string>();
    const workspaceLabels = new Map<string, string>();
    const workspacePaths = new Map<string, string>();
    for (const workspace of workspaces) {
      const input = {
        cliStorageRoot: cliStorageRoot(),
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
      };
      profileLabels.set(resolveProjectMemoryRoot(input), workspace.label);
      workspaceLabels.set(
        resolveProjectMemoryRoot({ ...input, storageLocation: "workspace" }),
        workspace.label,
      );
      workspacePaths.set(workspace.workspacePath, workspace.label);
    }
    const projects = join(cliStorageRoot(), "memories", "projects");
    try {
      await requireMemoryDirectoryChain(projects);
      for (const entry of await readdir(projects, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const memoryRoot = join(projects, entry.name, "memory");
        try {
          const stat = await lstat(memoryRoot);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        } catch (error) {
          if (isMemoryNotFound(error)) continue;
          throw error;
        }
        result.push({
          id: entry.name,
          label: profileLabels.get(memoryRoot) ?? entry.name.replace(/-[a-f0-9]{16}$/iu, ""),
          memoryRoot,
          storageLocation: "profile",
        });
      }
    } catch (error) {
      if (!isMemoryNotFound(error)) throw error;
    }
    if (options.settingService) {
      for (const [workspacePath, label] of workspacePaths) {
        const profile = resolveProjectMemoryRoot({
          cliStorageRoot: cliStorageRoot(),
          workspacePath,
        });
        result.push({
          id: `workspace:${basename(dirname(profile))}`,
          label,
          memoryRoot: resolveProjectMemoryRoot({
            cliStorageRoot: cliStorageRoot(),
            workspacePath,
            storageLocation: "workspace",
          }),
          storageLocation: "workspace",
        });
        const identitiesRoot = join(workspacePath, ".lcode", "memories");
        try {
          await requireMemoryDirectoryChain(identitiesRoot);
          const entries = await readdir(identitiesRoot, { withFileTypes: true });
          if (entries.length > 256)
            throw new Error("Project Memory identity catalog exceeds limit");
          // opaque 本地 identity 的 hash 由共享 resolver 产生；这里只枚举已存在的隔离根。
          for (const entry of entries) {
            if (
              !entry.isDirectory() ||
              entry.isSymbolicLink() ||
              !/^[a-f0-9]{16}$/u.test(entry.name)
            )
              continue;
            result.push({
              id: `workspace:${basename(dirname(profile))}:${entry.name}`,
              label:
                workspaceLabels.get(join(identitiesRoot, entry.name, "memory")) ??
                `${label} (${entry.name.slice(0, 8)})`,
              memoryRoot: join(identitiesRoot, entry.name, "memory"),
              storageLocation: "workspace",
            });
          }
        } catch (error) {
          if (!isMemoryNotFound(error)) throw error;
        }
      }
    }
    return result;
  }

  return {
    async listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]> {
      const result: ProjectMemoryWorkspaceSummary[] = [];
      for (const scope of await scopes()) {
        const files = await listMemoryFiles(scope.memoryRoot);
        if (files.length)
          result.push({
            ...scope,
            files,
            updatedAt: Math.max(...files.map((file) => file.updatedAt)),
          });
      }
      return result.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id, "en"));
    },
    async readProjectMemoryFile(params) {
      const scope = (await scopes()).find((candidate) => candidate.id === params.workspaceId);
      if (!scope) throw new Error("Unknown local Project Memory workspace");
      const filePath = await requireMemoryFile(scope.memoryRoot, params.fileName);
      return readProjectMemoryFileFromStableHandle({
        fileName: params.fileName,
        filePath,
        validatePath: async () => {
          await requireMemoryFile(scope.memoryRoot, params.fileName);
        },
      });
    },
    async changeStorageLocation({ location }) {
      if (location !== "profile" && location !== "workspace")
        throw new Error("Invalid Project Memory storage location");
      const settingService = options.settingService;
      if (!settingService) throw new Error("Project Memory storage settings are unavailable");
      // 多窗口切换共用命令锁；复制和 settings 提交有顺序，不能先广播新位置再复制文件。
      return withFileLock(join(getLCodeDataRootDir(), "memory-storage-settings"), async () => {
        const settings = await settingService.get();
        const previousStorageLocation = settings.memoryStorageLocation ?? "profile";
        // 旧 Runtime 可能晚于切换才初始化；位置与单调版本一起提交，阻止旧偏好回退迁移标记。
        // 设置写失败仍读取原版本，因此重试复用同一下一版本并补齐旧位置的新文件。
        const storageRevision =
          (settings.memoryStorageRevision ?? 0) + (location === previousStorageLocation ? 0 : 1);
        if (!Number.isSafeInteger(storageRevision) || storageRevision < 0)
          throw new Error("Project Memory storage revision is exhausted or invalid");
        let copiedCount = 0;
        let conflictCount = 0;
        for (const workspace of await listLocalMemoryWorkspaces(
          settings,
          options.worktreeService,
        )) {
          const result = await prepareLocalMemoryStorage(
            workspace,
            {
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
              cliStorageRoot: cliStorageRoot(),
              storageLocation: location,
              storageRevision,
              previousStorageLocation,
            },
            options.worktreeService,
          );
          copiedCount += result.copiedCount;
          conflictCount += result.conflictCount;
        }
        await settingService.update({
          memoryStorageLocation: location,
          memoryStorageRevision: storageRevision,
        });
        return { location, copiedCount, conflictCount };
      });
    },
  };
}
