import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { localProjectPathKey, type AppSettings } from "@lcode/shared";
import {
  prepareProjectMemoryStorage,
  resolveProjectMemoryRoot,
  withFileLock,
} from "@lcode/shared/node";
import type { ISettingService } from "../setting/setting.js";
import type { IMemoryService, ProjectMemoryWorkspaceSummary } from "./memory.js";
import { readProjectMemoryFileFromStableHandle } from "./projectMemoryStableRead.js";
import {
  isMemoryNotFound,
  listMemoryFiles,
  requireMemoryDirectoryChain,
  requireMemoryFile,
} from "./projectMemoryCatalog.js";
import { getConversationWorkspaceDir, getLCodeDataRootDir } from "../paths.js";

interface MemoryServiceOptions {
  settingService?: Pick<ISettingService, "get" | "update">;
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

function localProjectPaths(settings?: AppSettings): string[] {
  const explicit = [
    getConversationWorkspaceDir(),
    ...(settings?.localProjects ?? []).map((project) => project.primaryFolderPath),
    ...(settings?.lastWorkspaceSession ?? []).flatMap((entry) =>
      entry.kind === "local" ? [entry.workspacePath] : [],
    ),
  ];
  const remote = new Set(
    (settings?.lastWorkspaceSession ?? []).flatMap((entry) =>
      entry.kind === "remote" ? [localProjectPathKey(entry.workspacePath)] : [],
    ),
  );
  const explicitKeys = new Set(explicit.map(localProjectPathKey));
  const paths = [
    ...explicit,
    ...(settings?.recentProjects ?? []).filter(
      (path) =>
        !remote.has(localProjectPathKey(path)) || explicitKeys.has(localProjectPathKey(path)),
    ),
  ];
  const unique = new Map<string, string>();
  for (const path of paths) {
    // 最近项目可以包含远端标识；本地服务只接受本机绝对路径，不解析远端路径做 IO。
    if (
      !isAbsolute(path) ||
      /^[\\/]{2}/u.test(path) ||
      (process.platform === "win32" && !/^[A-Za-z]:[\\/]/u.test(path))
    )
      continue;
    unique.set(localProjectPathKey(resolve(path)), resolve(path));
  }
  return [...unique.values()];
}

async function existingLocalProjects(settings?: AppSettings): Promise<string[]> {
  const paths: string[] = [];
  for (const path of localProjectPaths(settings)) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new Error("Project Memory workspace directory cannot be a link");
      if (stat.isDirectory()) paths.push(path);
    } catch (error) {
      if (!isMemoryNotFound(error)) throw error;
    }
  }
  return paths;
}

export function createMemoryService(options: MemoryServiceOptions = {}): IMemoryService {
  async function scopes(): Promise<MemoryScope[]> {
    const result: MemoryScope[] = [];
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
          label: entry.name.replace(/-[a-f0-9]{16}$/iu, ""),
          memoryRoot,
          storageLocation: "profile",
        });
      }
    } catch (error) {
      if (!isMemoryNotFound(error)) throw error;
    }
    if (options.settingService) {
      for (const workspacePath of await existingLocalProjects(await options.settingService.get())) {
        const profile = resolveProjectMemoryRoot({
          cliStorageRoot: cliStorageRoot(),
          workspacePath,
        });
        result.push({
          id: `workspace:${basename(dirname(profile))}`,
          label: basename(workspacePath),
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
              label: `${basename(workspacePath)} (${entry.name.slice(0, 8)})`,
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
        for (const workspacePath of await existingLocalProjects(settings)) {
          const result = await prepareProjectMemoryStorage({
            workspacePath,
            cliStorageRoot: cliStorageRoot(),
            storageLocation: location,
            storageRevision,
            previousStorageLocation,
          });
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
