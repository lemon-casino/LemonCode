import type { RuntimeConsumerReference } from "@lcode/shared";
import type {
  RuntimeConsumerOwnerReceipt,
  RuntimeConsumerProcessOwner,
  RuntimeProcessOwnerObserver,
} from "../contract.js";
import { isDiscardSessionConsumer, isLegacyDiscardConsumer } from "../domain/legacyConsumers.js";

/** 只决定原确认 discard 能否继续；不写引用，也不把根进程不存在当作树退出证明。 */
export async function discardConsumerEligibility(
  ref: RuntimeConsumerReference,
  revision: number,
  sessions: ReadonlySet<string>,
  owners: readonly RuntimeConsumerOwnerReceipt[],
  observe?: RuntimeProcessOwnerObserver,
): Promise<{ orphanedOwner?: RuntimeConsumerProcessOwner } | undefined> {
  if (isLegacyDiscardConsumer(ref, revision, sessions, owners)) return {};
  if (!observe || !isDiscardSessionConsumer(ref, revision, sessions)) return undefined;
  const receipt = owners.find(
    (owner) =>
      owner.environmentId === ref.environmentId &&
      owner.revision === ref.revision &&
      owner.kind === ref.kind &&
      owner.id === ref.id &&
      owner.ownerId === ref.ownerId &&
      owner.ownerGeneration === ref.ownerGeneration &&
      owner.lease === ref.lease,
  );
  if (
    !receipt ||
    receipt.exitConfirmedAt ||
    ref.ownerId !== `runtime-agent-${receipt.processOwner.runtimeInstanceId}` ||
    receipt.processOwner.pid === undefined
  )
    return undefined;
  try {
    return (await observe(receipt.processOwner)) === "absent"
      ? { orphanedOwner: receipt.processOwner }
      : undefined;
  } catch {
    // 执行 Host 无法核实的 owner 继续阻塞，不能靠观察异常绕过释放边界。
    return undefined;
  }
}
