import type { WorktreeScope, CheckoutLease, IWorktreeHostService } from "../worktree/contract.js";
import type {
  ExecutionSetSnapshot,
  ExecutionSetPrepareRequest,
  ExecutionSetRef,
  ProjectContextSnapshot,
} from "@lcode/shared";
/** 仅可信 CLI admission / Host 使用；UI 无法注入项目事实或伪造停止证明。 */
export interface ProjectExecutionSetHostActions {
  getPreparation(
    request: WorktreeScope & { operationId: string },
  ): Promise<ExecutionSetSnapshot | null>;
  prepare(request: ExecutionSetPrepareRequest): Promise<ExecutionSetSnapshot>;
  attachSession(
    request: WorktreeScope & { executionSetId: string; sessionId: string; operationId: string },
  ): Promise<ExecutionSetRef>;
  resolveContext(
    request: WorktreeScope & { executionSetId: string; sessionId: string },
  ): Promise<{ reference: ExecutionSetRef; context: ProjectContextSnapshot }>;
  acquireExecution(
    request: WorktreeScope & { executionSetId: string; sessionId: string; ownerId: string },
    permits?: Pick<IWorktreeHostService, "acquireCheckout" | "releaseCheckout">,
  ): Promise<CheckoutLease[]>;
}
