import type { CommandAck, CommandEnvelope, CommandKey } from "@lcode/shared/lcode-protocol-v4";

/** guard 裁决结果：拒绝（撤 optimistic）或 noop（晚到者静默收口）。 */
export type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

export type PersistentLookup = (key: CommandKey) => Promise<CommandAck | null> | CommandAck | null;

export interface CommandInboxHost {
  /** 会话当前 revision；未知会话返回 null（createSession 用 null sessionId）。 */
  getRevision(sessionId: string): number | null;
  /** 会话当前投影代际；CAS 必须先校验 epoch，再校验 revision。 */
  getLogEpoch(sessionId: string): string | null;
  /** row-targeting command 的 entity/action 同源 resolver 裁决。 */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
  /** 业务 guard（product-protocol guard id）。缺省一律放行。 */
  guard?(envelope: CommandEnvelope): GuardDecision;
  /** 以下回调顺序就是持久化事实优先级；实现必须精确匹配 sourceCommandId。 */
  lookupTranscriptCommand?: PersistentLookup;
  lookupTimelineCommand?: PersistentLookup;
  lookupChildCommand?: PersistentLookup;
  lookupDiscardedCommand?: PersistentLookup;
  now?(): number;
}
