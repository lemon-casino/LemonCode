import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在本地 Project Memory 根目录内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
  storageLocation?: "profile" | "workspace";
  memoryRoot?: string;
}

export interface IMemoryService {
  /** 列出本机 profile 与已知本地项目/工作树中的记忆；目录浏览不触发迁移。 */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** 复制已知本机项目/工作树记忆并保留源，再通过 SettingService 提交位置。 */
  changeStorageLocation(params: { location: "profile" | "workspace" }): Promise<{
    location: "profile" | "workspace";
    copiedCount: number;
    conflictCount: number;
  }>;

  /** 原样读取一个 Project Memory Markdown 文件。 */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
