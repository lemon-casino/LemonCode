import type { BindingOwnerRef } from "@lcode/shared";
import type { WorktreeBinding, WorktreePrepareRequest, WorktreeScope } from "./contract.js";

export type WorktreeOwnedPrepareRequest = Omit<
  WorktreePrepareRequest,
  "taskId" | "parentBinding"
> & {
  ownerRef: Extract<BindingOwnerRef, { kind: "executionSet" }>;
  taskId?: never;
  parentBinding?: never;
};
export type WorktreePreparationRequest = Omit<WorktreePrepareRequest, "taskId"> & {
  taskId?: string;
  ownerRef?: BindingOwnerRef;
};
/** 可信 Host 合同；不能通过公开 worktree RPC 调用或用 taskId 模拟 set owner。 */
export interface WorktreeOwnedBindings {
  inspectOwnedRepository(
    request: WorktreeScope & { baseRef?: string; requireDirectoryAtRef?: true },
  ): Promise<{
    root: string;
    commonDirectory: string;
    head: string;
    branch: string;
    canonicalPath: string;
  }>;
  prepareOwnedBinding(request: WorktreeOwnedPrepareRequest): Promise<WorktreeBinding>;
  getOwnedBinding(
    request: WorktreeScope & { ownerRef: Extract<BindingOwnerRef, { kind: "executionSet" }> },
  ): Promise<WorktreeBinding | null>;
  attachBindingConsumer(request: {
    bindingId: string;
    owner: BindingOwnerRef;
    operationId: string;
  }): Promise<WorktreeBinding>;
  detachBindingConsumer(request: {
    bindingId: string;
    owner: BindingOwnerRef;
    operationId: string;
    stopReceipt: { stopped: true; operationId: string };
  }): Promise<WorktreeBinding>;
}
