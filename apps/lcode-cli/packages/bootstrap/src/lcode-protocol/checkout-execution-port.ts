import type { AgentRuntimeDeps } from "@lcode/core";
import {
  checkoutAcquireWriterResultSchema,
  checkoutReleaseWriterResultSchema,
  lcodeProtocolMethods,
  type LCodeWorkspaceRef,
  type WorktreeRepairScope,
} from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { setTimeout as delay } from "node:timers/promises";

export function createProtocolCheckoutExecutionPort(
  context: Pick<LCodeProtocolAgentServerContext, "requestClient">,
  workspace: LCodeWorkspaceRef,
  repair?: WorktreeRepairScope,
): NonNullable<AgentRuntimeDeps["checkoutExecutionPort"]> {
  return {
    async acquire({ sessionId, turnId, signal }) {
      signal.throwIfAborted();
      let permitId: string;
      let additionalPermitIds: string[] | undefined;
      try {
        // 不能在已发申请上直接 race abort：Host 可能已授予票据，而取消会丢掉唯一 token。
        while (true) {
          signal.throwIfAborted();
          const result = await context.requestClient(
            lcodeProtocolMethods.checkoutAcquireWriter,
            {
              requestId: `${sessionId}:${turnId}`,
              sessionId,
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity,
              ...(repair ? { repair } : {}),
              ...(workspace.executionSetRef ? { executionSetRef: workspace.executionSetRef } : {}),
            },
            checkoutAcquireWriterResultSchema,
          );
          if ("permitId" in result) {
            permitId = result.permitId;
            additionalPermitIds = result.additionalPermitIds;
            break;
          }
          // 这是同一次已接受执行的许可等待，不创建第二条输入，也不把超时当成 writer 退出。
          await delay(100, undefined, { signal });
        }
      } catch (error) {
        if (
          !workspace.executionBindingId &&
          !workspace.executionSetRef &&
          !repair &&
          (error as { code?: unknown })?.code === -32601
        ) {
          signal.throwIfAborted();
          return { release: async () => undefined };
        }
        throw error;
      }
      let released = false;
      const release = async () => {
        if (released) return;
        const result = await context.requestClient(
          lcodeProtocolMethods.checkoutReleaseWriter,
          { permitId, sessionId, ...(additionalPermitIds?.length ? { additionalPermitIds } : {}) },
          checkoutReleaseWriterResultSchema,
          { purpose: "resource_cleanup" },
        );
        if (!result.released)
          throw new Error("Checkout owner did not release the execution permit");
        released = true;
      };
      if (signal.aborted) {
        await release();
        signal.throwIfAborted();
      }
      return { release };
    },
  };
}
