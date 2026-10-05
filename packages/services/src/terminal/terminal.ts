import type { Event } from "@lcode/rpc";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfile.js";

export interface TerminalWindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

export interface ITerminalService {
  create(params: {
    cols: number;
    rows: number;
    cwd?: string;
    /**
     * 冻结运行环境覆盖键值（spec: specs/worktree-runtime-environments.md §9.3，P2-04）。
     * 仅叠加到终端进程环境（如 PATH 工具目录前缀），不改 Host process.env；
     * 缺省 = 非托管终端，保持现状语义。
     */
    envOverlay?: Record<string, string>;
  }): Promise<{
    id: string;
    shell: string;
    fontFamily: string;
    fontSize?: number;
    theme?: TerminalThemeProfile;
    fontFamilySource: TerminalFontFamilySource;
    windowsPty?: TerminalWindowsPtyInfo;
  }>;
  write(params: { id: string; data: string }): Promise<void>;
  resize(params: { id: string; cols: number; rows: number }): Promise<void>;
  dispose(params: { id: string }): Promise<void>;
  onDynamicData(id: string): Event<string>;
  onDynamicExit(id: string): Event<number>;
}

export const ITerminalService = createServiceDescriptor<ITerminalService>(ServiceChannels.Terminal);
