/** ACK 的结构化归因沿调用链保留；不把服务端错误正文直接显示给用户。 */
export class QueueSendNowError extends Error {
  constructor(readonly reasonCode?: string) {
    super("Queued message could not start");
    this.name = "QueueSendNowError";
  }
}

export function queueSendNowFailureMessageId(error: unknown): string {
  // 旧实现把收尾超时一律提示为模型问题，导致用户改选模型后仍无法启动。
  if (!(error instanceof QueueSendNowError)) return "chat.queue.sendNowFailed";
  switch (error.reasonCode) {
    case "fault.command.sessionIdleTimeout":
      return "chat.queue.sendNowWaiting";
    case "guard.queuePromotionBusy":
    case "guard.queueItemReserved":
      return "chat.queue.sendNowBusy";
    case "restoreWarning":
      return "chat.queue.sendNowModelUnavailable";
    case "stale":
      return "chat.queue.sendNowChanged";
    default:
      return "chat.queue.sendNowFailed";
  }
}
