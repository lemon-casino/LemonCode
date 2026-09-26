/**
 * 调度器的会话创建与派发边界。会话身份归 driver，调度器只缓存创建 promise 并在派发前补齐 journal。
 */

import { actorModelBindingOf } from "./actor-model-provenance.js";
import { describeCause } from "./scheduler-helpers.js";
import type { Actor, AskNode, SchedulerHost } from "./scheduler-types.js";
import { WorkflowError, type AskMessage, type SessionRef } from "./types.js";

export interface SchedulerDispatchSeam {
  readonly host: SchedulerHost;
  settleFailed(node: AskNode, error: WorkflowError): void;
}

export async function dispatchAsk(seam: SchedulerDispatchSeam, node: AskNode): Promise<void> {
  const { host } = seam;
  const attempt = node.instance.attempt ?? 1;
  let session: SessionRef;
  try {
    session = await ensureActorSession(host, node.actor);
  } catch (cause) {
    if (
      host.isRunSettled() ||
      node.settled ||
      node.paused ||
      (node.instance.attempt ?? 1) !== attempt
    )
      return;
    // cause 必须进入错误文本：WorkflowError.toJSON 不持久化 cause，否则会话创建失败无法诊断。
    seam.settleFailed(
      node,
      new WorkflowError(
        "DriverError",
        `Failed to create the subagent session: ${describeCause(cause)}`,
        { cause },
      ),
    );
    return;
  }
  if (
    host.isRunSettled() ||
    node.settled ||
    node.paused ||
    (node.instance.attempt ?? 1) !== attempt ||
    node.actor.current !== node
  )
    return;
  // 进程级闸门在 driver 下方按模型请求准入；这里仅守 per-run 的 ask 上限。
  host.record({ type: "node-dispatched", instance: node.instance });
  node.dispatched = true;
  const message: AskMessage = {
    instructions: node.instructions,
    ...(node.attachments === undefined ? {} : { attachments: node.attachments }),
    typed: node.spec.typed,
    schema: node.spec.schema,
  };
  host.driver.startAsk(session, node.instance, message);
}

function ensureActorSession(host: SchedulerHost, actor: Actor): Promise<SessionRef> {
  if (actor.sessionPromise !== undefined) return actor.sessionPromise;
  // 种子只有运行期分歧时才确定；引擎持有导入态，driver 持有会话 store。
  const seed = actor.imported?.seed();
  const promise = host.driver.createActorSession(actor.ref, actor.persona, seed).then((session) => {
    actor.session = session;
    // runtime factory 已在 createActorSession 内写入模型绑定；整行替换时必须原子带回。
    const binding = host.driver.journal.getActor(host.runId, actor.ref.siteId, actor.ref.ordinal);
    host.driver.journal.putActor({
      runId: host.runId,
      siteId: actor.ref.siteId,
      ordinal: actor.ref.ordinal,
      name: actor.name,
      persona: actor.persona,
      sessionId: session.id,
      ...actorModelBindingOf(binding),
    });
    return session;
  });
  actor.sessionPromise = promise;
  return promise;
}
