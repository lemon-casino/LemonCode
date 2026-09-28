import { refToString, type InstanceRef, type JournalStorePort, type WorkflowImageRef } from "./types.js";

export interface RecoveredAskControlState {
  attempt: number;
  paused: boolean;
  /** 最近一次重跑累计的用户修订；冷恢复后继续使用同一份有效指令。 */
  supplement?: string;
  attachments?: WorkflowImageRef[];
}

/** Rebuild task-level stop/retry state from durable events during cold resume. */
export function recoverAskControlStates(
  journal: JournalStorePort,
  runId: string,
): ReadonlyMap<string, RecoveredAskControlState> {
  const states = new Map<string, RecoveredAskControlState>();
  for (const stored of journal.listEvents(runId)) {
    const event = stored.event;
    if (event.type !== "node-paused" && event.type !== "node-retried") continue;
    const previous = states.get(refToString(event.instance));
    states.set(refToString(event.instance), {
      attempt: event.instance.attempt ?? 1,
      paused: event.type === "node-paused",
      ...((event.type === "node-retried" ? event.attachments : previous?.attachments) === undefined
        ? {} : { attachments: event.type === "node-retried" ? event.attachments : previous?.attachments }),
      ...((event.type === "node-retried" ? event.supplement : previous?.supplement) === undefined
        ? {}
        : {
            supplement: event.type === "node-retried" ? event.supplement : previous?.supplement,
          }),
    });
  }
  return states;
}

export function recoverInstanceAttempt(
  instance: InstanceRef,
  state: RecoveredAskControlState | undefined,
): InstanceRef {
  return state === undefined || state.attempt <= 1
    ? instance
    : { ...instance, attempt: state.attempt };
}
