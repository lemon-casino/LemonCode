import { useEffect, useRef, useState } from "react";
import type { WorktreeBinding } from "@lcode/services";
import { useServices } from "./useServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

/** 轮询只读取 Host 持久事实；不以经过时间推进阶段，也不重放创建或首条输入。 */
export function useWorktreePreparation(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  requestId: string | undefined,
  taskId?: string,
  pending = false,
) {
  const { worktreeService } = useServices();
  const scope = JSON.stringify([workspaceIdentity?.trim() || workspacePath, requestId, taskId]);
  const [state, setState] = useState<{
    scope: string;
    binding: WorktreeBinding | null;
    error?: string;
  }>({ scope, binding: null });
  const ticket = useRef(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const own = ++ticket.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if ((!requestId && !taskId) || !worktreeService) return;
      let again = true;
      try {
        const binding = await worktreeService.getBinding({
          workspacePath,
          workspaceIdentity,
          requestId,
          taskId,
        });
        if (ticket.current !== own) return;
        setState({ scope, binding });
        // 同一 commandId 重试可能先读到旧失败快照；在途请求未收口时不能据此停止读取。
        again = pending || !binding || binding.status === "preparing";
      } catch (reason) {
        if (ticket.current !== own) return;
        setState((value) => ({
          scope,
          binding: value.scope === scope ? value.binding : null,
          error: getErrorMessage(reason),
        }));
      }
      if (again && ticket.current === own) timer = setTimeout(() => void read(), 750);
    };
    void read();
    return () => {
      ++ticket.current;
      clearTimeout(timer);
    };
  }, [
    scope,
    requestId,
    taskId,
    pending,
    workspacePath,
    workspaceIdentity,
    worktreeService,
    revision,
  ]);
  return {
    ...(state.scope === scope ? state : { scope, binding: null, error: undefined }),
    refresh: () => setRevision((value) => value + 1),
  };
}
