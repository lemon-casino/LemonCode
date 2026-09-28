import type { LCodeProvider, SkillsPromptContext, SkillsListResult } from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: LCodeProvider;
  }): Promise<SkillsListResult>;
  setEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: LCodeProvider;
    scope?: "workspace" | "user" | "plugin";
    skillId: string;
    enabled: boolean;
  }): Promise<void>;
  buildPromptContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: LCodeProvider;
    prompt: string;
  }): Promise<SkillsPromptContext>;
  /** 将指定 skill 复制到通用目录（.lcode/skills），成功后返回新 skill 的路径。 */
  copyToCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<{ newPath: string }>;
  /** 从通用目录中移除指定 skill（仅当 skill 位于 .lcode/skills 时有效）。 */
  removeFromCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /**
   * 删除本地技能（仅 workspace/user 作用域；plugin 作用域拒绝）。
   * 删除技能所在目录，仅允许命中 .lcode/skills 或 .agents/skills 根，越界则拒绝。
   */
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
}

export const ISkillsService = createServiceDescriptor<ISkillsService>(ServiceChannels.Skills);
