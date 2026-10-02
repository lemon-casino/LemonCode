import type { Actor, AskNode, SchedulerHost } from "./scheduler-types.js";
import type { InstanceRef } from "./types.js";

type AdmissionEvent = NonNullable<AskNode["lastAdmission"]>;

function sameAttempt(left: InstanceRef | undefined, right: InstanceRef | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.siteId === right.siteId &&
    left.ordinal === right.ordinal &&
    (left.attempt ?? 1) === (right.attempt ?? 1)
  );
}

/** 获得名额后清旧原因：建会话仍可能异步等待，不能等 node-dispatched 才消除假排队。 */
export function clearActorAdmission(host: SchedulerHost, node: AskNode): void {
  const previous = node.lastAdmission;
  node.lastAdmission = undefined;
  if (
    host.isRunSettled() ||
    node.settled ||
    node.paused ||
    node.dispatched ||
    previous === undefined ||
    !sameAttempt(previous.instance, node.instance)
  )
    return;
  host.record({ type: "node-admission", instance: { ...node.instance }, cause: null });
}

/**
 * 只观察既有 pump 的阻塞条件；节点/队列与 activeAsks 仍由 AskScheduler 唯一持有。
 * 不能因 run 满员就把整条 actor 队列标成容量等待：后项首先等待同 actor 的前项。
 */
export function observeActorAdmission(host: SchedulerHost, actor: Actor, activeAsks: number): void {
  if (host.isRunSettled()) return;
  let predecessor = actor.paused ?? actor.current;
  for (const node of actor.liveQueue) {
    // liveQueue 只包含已发 node-queued 的节点；终态或暂停节点不再产生排队观察。
    if (node.settled || node.paused || node.dispatched) continue;
    const blockedBy = predecessor?.instance;
    const cause =
      blockedBy !== undefined
        ? "actor-fifo"
        : activeAsks >= host.caps.maxConcurrency
          ? "run-capacity"
          : undefined;
    predecessor = node;
    if (cause === undefined) continue;
    const previous = node.lastAdmission;
    if (
      previous?.cause === cause &&
      sameAttempt(previous.instance, node.instance) &&
      sameAttempt(previous.blockedBy, blockedBy)
    )
      continue;
    // 留下身份快照，而非 AskNode 引用：retry 会换 attempt，旧 journal 事实不能随它一起改变。
    const event: AdmissionEvent = {
      type: "node-admission",
      instance: { ...node.instance },
      cause,
      ...(blockedBy === undefined ? {} : { blockedBy: { ...blockedBy } }),
    };
    node.lastAdmission = event;
    host.record(event);
  }
}
