import type { ActorRef, InstanceRef, NodeKind } from "./types.js";

/** 节点出生及排队观察单独收口，避免边界词汇表继续超过单文件行数上限。 */
export interface NodeQueuedEvent {
  type: "node-queued";
  instance: InstanceRef;
  kind: NodeKind;
  actor?: ActorRef;
  actorSeq?: number;
  phaseName?: string;
  /**
   * 作者指令的开头 INSTRUCTIONS_HEAD_MAX_CHARS 个字符（去两端空白、不加省略号），只在 ask 上在场。
   * 取准入时的原文，不含 driver 的质量/schema 尾注；完整指令不进入出生事件。
   */
  instructionsHead?: string;
}

/**
 * Scheduler 对已 queued、未 dispatched/paused/settled ask 的纯观察，不参与派发或缓存决策。
 * FIFO 原因优先于 run 名额；blockedBy 来自同 actor 的真实前项，并保留其当时的尝试代次。
 * 重复的原因与阻塞实例不重发；新 queued 或 retried 尝试从空观察开始。
 * 已获 run 名额但会话尚未创建完成时，只清掉旧原因，不提前发 node-dispatched。
 */
export type NodeAdmissionEvent =
  | {
      type: "node-admission";
      instance: InstanceRef;
      cause: "actor-fifo" | "run-capacity";
      blockedBy?: InstanceRef;
    }
  | { type: "node-admission"; instance: InstanceRef; cause: null; blockedBy?: never };
