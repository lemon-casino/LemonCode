import type { SessionStorePort } from "@lcode/contracts";
import type { WorkflowJournalOwnerLease } from "@lcode/dynamic-workflow";
import { isClosableSessionStore } from "./session-store.js";

/** 存储公开的执行 lease 能力；不从 Bootstrap 访问 SQLite 实现或 db 句柄。 */
export async function acquireAppWorkflowExecutionOwner(input: {
  sessionStore: SessionStorePort;
  parentSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  ownsSessionStore?: boolean;
}): Promise<WorkflowJournalOwnerLease | undefined> {
  const store = input.sessionStore as SessionStorePort & {
    acquireWorkflowExecutionOwner?: (input: {
      parentSessionId: string;
      workspaceKey: string;
    }) => Promise<WorkflowJournalOwnerLease>;
  };
  try {
    return await store.acquireWorkflowExecutionOwner?.({
      parentSessionId: input.parentSessionId,
      workspaceKey: input.workspaceIdentity?.trim() || input.workspacePath,
    });
  } catch (error) {
    // 准入失败时还没有 runtime 可替我们回收；只处理本 App 自建的 store，不关闭共享连接。
    if (input.ownsSessionStore && isClosableSessionStore(store)) {
      try {
        store.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Workflow ownership admission and store cleanup failed",
          { cause: error },
        );
      }
    }
    throw error;
  }
}
