import type { WorkflowRunActor, WorkflowRunState } from "./workflow-runs.js";

/** Actor state is derived from its asks; there is no independent actor lifecycle event. */
export function withDerivedWorkflowActorStatuses(run: WorkflowRunState): WorkflowRunState {
  const executing = new Set<string>();
  const live = new Set<string>();
  const owned = new Set<string>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = `${node.actorSiteId}\0${node.actorOrdinal}`;
    owned.add(key);
    switch (node.phase) {
      case "executing":
      case "repairing":
      case "nudged":
        executing.add(key);
        break;
      case "queued":
      case "dispatched":
      case "waiting":
      case "paused":
        live.add(key);
        break;
      default:
        break;
    }
  }
  const runLive = run.status === "pending" || run.status === "running";
  return {
    ...run,
    actors: run.actors.map((actor) => {
      const key = `${actor.siteId}\0${actor.ordinal}`;
      // 节点窗口满额后会回收较早的 settled 行；没有留下节点不等于已完成的代理重新等待。
      const status: WorkflowRunActor["status"] = !runLive
        ? "completed"
        : executing.has(key)
          ? "running"
          : live.has(key) ||
              (!owned.has(key) && (run.truncated !== true || actor.status !== "completed"))
            ? "waiting"
            : "completed";
      return actor.status === status ? actor : { ...actor, status };
    }),
  };
}
