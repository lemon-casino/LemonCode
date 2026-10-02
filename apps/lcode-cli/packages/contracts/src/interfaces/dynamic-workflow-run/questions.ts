/** 一个停驻中的升级问题。字段与 `escalation-raised` 事件同源，另加提问时刻。 */
export interface DynamicWorkflowRunPendingQuestion {
  /** 全局唯一的问题 id（形如 `dwfq-<runId 片段>-<seq>`）；`resolveQuestion` 只认它。 */
  qid: string;
  /** 提问的 actor，`refToString` 形态（如 `actor#1@1`）。恒在场，且在 run 内唯一定位。 */
  actor: string;
  /**
   * 这个 actor 的人类可读名（脚本里 `agent("poet")` 的 `"poet"`）。
   *
   * **匿名 actor 缺席本字段，且这里不合成任何兜底标签**：兜底是渲染决策，通知面与侧栏各有
   * 各的合适写法（一个要读成句子，一个要塞进一列）。在这里合成一个「actor#1@1」当名字，
   * 只会让两个消费者都拿不回「这个 actor 其实没有名字」这条事实。
   */
  actorName?: string;
  question: string;
  /** actor 补充的上下文（`escalate` 的可选 `context`）。 */
  context?: string;
  /** 提问时刻（epoch ms）。主代理据它判断「这个问题已经等了多久」。 */
  askedAt: number;
}

/**
 * {@link DynamicWorkflowRunPort.resolveQuestion} 的结构化拒绝理由。三者对模型是**三个不同的
 * 下一步**，所以必须可分辨：去快照里取正确的 id / 什么都不用做 / 这个 run 已经不需要答案了。
 */
export type DynamicWorkflowResolveQuestionRefusalReason =
  /** 注册表里没有这个 qid：拼错了，或来自已亡故进程的陈旧 id（停驻项不持久化）。 */
  | "unknown_question"
  /** 这个问题已经被回答过，actor 早已带着那次答案继续。 */
  | "already_resolved"
  /** qid 所属的 run / ask 已不在飞行中（被取消、失败或已结束），没有人在等这个答案。 */
  | "run_not_in_flight";

/**
 * `resolveQuestion` 的结构化结果。失败走 reason 而不是 throw，与
 * {@link DynamicWorkflowRunSubmitResult} 同一条论证：三种理由全是调用方可预期的业务分支。
 *
 * `message` 由实现侧写好（陈述现状与下一步）而不是留给工具层拼：判别键与文案分开维护，
 * 两处迟早会说不同的话，而这里的读者是模型——它读到的就是它的下一步。
 */
export type DynamicWorkflowResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: DynamicWorkflowResolveQuestionRefusalReason; message: string };
