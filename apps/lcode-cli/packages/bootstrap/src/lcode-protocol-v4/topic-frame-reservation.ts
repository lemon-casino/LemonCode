import type { TopicFrameDeliveryKind } from "@lcode/shared/lcode-protocol-v4";

/** publisher 水位的两阶段提交句柄。 */
export interface TopicFrameReservation<F> {
  /** 由 publisher admission 权威赋值，物理分片与 consumer 不得按时序猜测。 */
  readonly deliveryKind: TopicFrameDeliveryKind;
  readonly logicalFrameId: string;
  /** 同一 subscription 内单调递增；用于拒绝 PersistentProtocol 旧帧 replay。 */
  readonly logicalFrameOrdinal: number;
  readonly frame: F;
  /** 只有当前 subscription generation 仍有效时推进水位。 */
  commit(): boolean;
}
