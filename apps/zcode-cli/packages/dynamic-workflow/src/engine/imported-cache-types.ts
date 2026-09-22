// ============================================================
// amend-resume 的导入缓存
// ============================================================
// 从 engine/types.ts 拆出（该文件已到 oxlint max-lines 上限）：纯数据结构，run service 读前驱
// journal 构建，引擎只查表。

import type { AskStats, NodeKind, PersonaSpec } from "./types.js";

/**
 * 一条可导入的已完结 ask：前驱 run 里某具名 actor 第 `actorSeq` 次问答的结果。
 * 数组下标即 actorSeq（见 {@link ImportedActorCandidate.entries}），所以这里不存 seq。
 */
export interface ImportedAskEntry {
  /** 前驱记录的 inputHash（对指令正文）。运行期与本次 ask 的哈希逐条比对，一致才命中。 */
  inputHash: string;
  result: unknown;
  stats?: AskStats;
  /**
   * 该 ask 结算后源会话的消息数（{@link NodeRecord.messageBoundary}）。**必填**：
   * run service 的「无 marker 前驱整体拒绝」门保证每条可导条目都带边界，所以引擎这边
   * 不必有缺席分支——种子截断没有边界就无从谈起。
   */
  messageBoundary: number;
}

/**
 * 前驱 run 里一个具名 actor 的可导入前缀。由 run service 从前驱 journal 构建（纯确定，可重建）。
 */
export interface ImportedActorCandidate {
  /** 前驱记录的规范化 persona——运行期 createActor 比对用（不一致即弃该候选）。 */
  persona: PersonaSpec;
  /** 最长全 completed ask 前缀，按 actorSeq 0..n-1 索引。 */
  entries: ImportedAskEntry[];
  /**
   * 经 `resumed_from` 链解析出的转录源会话 id。service 保证在场——链上没有任何祖先
   * 持有该 actor 会话的候选在 service 侧就已弃置（降级为全新 actor），所以这里不是可选。
   */
  transcriptSourceSessionId: string;
  /**
   * 前驱解析出的模型 pin，随种子带给 driver。**仅当真的导入了转录时生效**：一条也没命中的
   * actor 走全新解析、不带 pin（见 scheduler 的 ensureSession）。
   */
  resolvedModel?: string;
}

/** 一条可导入的世界节点（world-read / world-run），按内容 + 出现序匹配。 */
export interface ImportedWorldEntry {
  inputHash: string;
  kind: NodeKind;
  result: unknown;
}

/**
 * 注入引擎的导入缓存（amend-resume 的加速结构）。**纯数据**：引擎保持零 I/O，这张表由
 * run service 读前驱 journal 构建。
 * 它不是真相源——每次命中都落一行真 dwf_node，丢了可从 `resumed_from` 重建。
 */
export interface ImportedRunCache {
  /** 键 = 有效 actor 名（前驱内唯一且非空的那些）。 */
  actors: ReadonlyMap<string, ImportedActorCandidate>;
  /**
   * 键 = `inputHash({op, args})`；值 = 按前驱 listNodes 插入序排好的队列——同一个
   * `{op,args}` 的第 n 次出现对第 n 条记录。失败/中断的出现用 null 占位，
   * 消费时仍推进游标，但绝不导入它们的结果。
   */
  world: ReadonlyMap<string, (ImportedWorldEntry | null)[]>;
}
