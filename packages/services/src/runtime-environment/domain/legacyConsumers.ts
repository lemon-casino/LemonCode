import type { RuntimeConsumerReference } from "@lcode/shared";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
/** 删除恢复只识别原桥接的精确会话格式，不能扩展到其他执行消费者。 */
export function isDiscardSessionConsumer(
  ref: RuntimeConsumerReference,
  revision: number,
  sessionIds: ReadonlySet<string>,
): boolean {
  if (
    ref.state !== "active" ||
    ref.kind !== "process" ||
    ref.revision !== revision ||
    !ref.ownerId.startsWith("runtime-agent-")
  )
    return false;
  try {
    const value: unknown = JSON.parse(ref.id);
    return (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      uuid.test(value[1]) &&
      sessionIds.has(value[0]) &&
      ref.id === JSON.stringify(value)
    );
  } catch {
    return false;
  }
}

/** 有 owner 收据的引用必须经过独立观察，不能按旧数据直接退役。 */
export function isLegacyDiscardConsumer(
  ref: RuntimeConsumerReference,
  revision: number,
  sessionIds: ReadonlySet<string>,
  ownerReceipts: readonly { id: string }[],
): boolean {
  return (
    isDiscardSessionConsumer(ref, revision, sessionIds) &&
    // 旧引用无实际 owner 收据，保留原迁移格式；现代身份由完整收据授权，不能猜 UUID。
    uuid.test(ref.ownerId.slice("runtime-agent-".length)) &&
    !ownerReceipts.some((receipt) => receipt.id === ref.id)
  );
}
