/**
 * actor journal 行与会话种子共享模型绑定，但各自保留独立的身份字段。
 * 类型从 types.ts 拆出；types.ts 继续原地转出，外部导入路径不变。
 */

import {
  actorModelBindingOf,
  type ActorModelBinding,
  type PersonaSpec,
} from "./actor-model-provenance.js";
import type { JournalStorePort } from "./journal-types.js";

/** dwf_actor 记录，unique(runId, siteId, ordinal)。 */
export interface ActorRecord extends ActorModelBinding {
  runId: string;
  siteId: string;
  ordinal: number;
  name?: string;
  persona?: PersonaSpec;
  sessionId?: string;
}

/**
 * 会话种子：分歧 actor 首次 live 派发时交给 driver，让新会话以源会话的全保真转录前缀开场。
 */
export interface ActorSessionSeed extends ActorModelBinding {
  /** 转录来源会话（前驱或更早祖先的该名 actor 会话）。 */
  sourceSessionId: string;
  /** 复制源会话前多少条消息；count offset 在前缀复制后保持不变。 */
  messageCount: number;
}

/** createActor 重放会替换整行；driver 拥有的 session 与模型绑定必须原样保留。 */
export function putActorDefinition(
  journal: Pick<JournalStorePort, "getActor" | "putActor">,
  runId: string,
  ref: { siteId: string; ordinal: number },
  name: string | undefined,
  persona: PersonaSpec,
): void {
  const existing = journal.getActor(runId, ref.siteId, ref.ordinal);
  journal.putActor({
    runId,
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    name,
    persona,
    sessionId: existing?.sessionId,
    ...actorModelBindingOf(existing),
  });
}
