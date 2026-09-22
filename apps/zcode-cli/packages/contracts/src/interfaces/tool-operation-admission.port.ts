import type { ToolSideEffectScope } from "../tools/contract.js";

export interface ToolOperationAdmissionPort {
  acquire(input: {
    toolName: string;
    toolInput: unknown;
    readOnly?: boolean;
    sideEffectScope?: ToolSideEffectScope;
    workingDirectory: string;
    workspaceRoot: string;
    signal?: AbortSignal;
  }): Promise<() => void>;
}
