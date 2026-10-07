import type { Event } from "@lcode/rpc";
import { ServiceChannels, runtimeEnvironmentReferenceSchema } from "@lcode/shared";
import { z } from "zod";
import { createServiceDescriptor } from "../descriptors.js";
import type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfile.js";

export interface TerminalWindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

const scopeText = z.string().trim().min(1).max(4096);

/** RPC 只接受执行身份，冻结环境由可信 Host port 提供，不能接收 UI 的 PATH。 */
export const terminalCreateParamsSchema = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    cwd: scopeText.optional(),
    workspacePath: scopeText.optional(),
    workspaceIdentity: scopeText.optional(),
    sessionId: scopeText.optional(),
    remoteSessionId: scopeText.optional(),
    executionBindingId: scopeText.optional(),
    environmentRef: runtimeEnvironmentReferenceSchema.optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if (
      !params.workspacePath &&
      (params.workspaceIdentity ||
        params.sessionId ||
        params.remoteSessionId ||
        params.executionBindingId ||
        params.environmentRef)
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "workspacePath is required for terminal execution scope",
      });
    }
  });
export type TerminalCreateParams = z.infer<typeof terminalCreateParamsSchema>;

export interface RuntimeTerminalScope {
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface RuntimeTerminalEnvironmentLease {
  /** Host 核验后的 checkout scope，供删除/升级按绑定精确停止。 */
  executionScope?: RuntimeTerminalScope;
  /** Host resolveContext 核验后的实际目录，可位于 checkout 子目录。 */
  cwd?: string;
  envOverlay: { base?: "inherit" | "empty"; set?: Record<string, string>; unset?: string[] };
  /** 无 PTY 的创建失败或真实 onExit 后调用；闭包持有精确 owner generation/lease。 */
  release(): Promise<void>;
}
/** 本地组合根注入，不作为 RPC 服务；null 只能表示已核验的 legacy 环境。 */
export interface RuntimeTerminalEnvironmentPort {
  acquire(
    request: RuntimeTerminalScope &
      Pick<
        TerminalCreateParams,
        "cwd" | "sessionId" | "remoteSessionId" | "executionBindingId" | "environmentRef"
      > & { terminalId: string },
  ): Promise<RuntimeTerminalEnvironmentLease | null>;
}

export interface ITerminalService {
  create(params: TerminalCreateParams): Promise<{
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
