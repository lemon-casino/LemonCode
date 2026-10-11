import {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type SessionTranscriptSnapshot,
} from "@lcode/contracts";
import { MemoryReviewError } from "./review-common.js";

export function assertReviewTranscriptBudget(snapshot: SessionTranscriptSnapshot): void {
  const partCount = snapshot.messages.reduce((sum, message) => sum + message.parts.length, 0);
  if (
    snapshot.messages.length > SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS ||
    partCount > SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS ||
    snapshot.loadedMessageCount !== snapshot.messages.length ||
    snapshot.loadedPartCount !== partCount ||
    !Number.isSafeInteger(snapshot.loadedDataBytes) ||
    snapshot.loadedDataBytes < 0 ||
    snapshot.loadedDataBytes > SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES
  )
    throw new MemoryReviewError("budget_exceeded");

  // 原因：adapter按data列字节准入，解码补上的行ID和容器不属于同一预算。
  // 移除端口注入字段后重新计量payload下界，仍拒绝超额材料或虚报loadedDataBytes，
  // 不靠扩大读取上限、丢掉安全校验或截断真实用户轮绕过问题。
  let payloadBytes = 0;
  for (const message of snapshot.messages) {
    const { id: _id, sessionID: _session, ...data } = message.info;
    payloadBytes += Buffer.byteLength(JSON.stringify(data));
    for (const part of message.parts) {
      const { id: _part, sessionID: _scope, messageID: _message, ...payload } = part;
      payloadBytes += Buffer.byteLength(JSON.stringify(payload));
    }
    if (payloadBytes > snapshot.loadedDataBytes) throw new MemoryReviewError("budget_exceeded");
  }
}
