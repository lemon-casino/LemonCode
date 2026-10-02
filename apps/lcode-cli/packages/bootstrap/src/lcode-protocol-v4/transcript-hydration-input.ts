// Transcript → SessionEvent 合成（「reduce(transcript) ≡ reduce(events)」）。
//
// 动机：v4 投影是事件溯源，但部分历史突变（纯对话 fork 复制 message 不复制 event、
// rewind 截断只动 message 库）会让 session 的事件日志无法覆盖可见 transcript。冷订阅
// hydration 从事件日志重建拿不到这些历史（「fork-child 历史」）。
//
// 本模块把 message 库的 transcript 反向合成为 reducer 能消费的 SessionEvent 序列——
// 从而复用整套 ProductProjection 归约逻辑，不必再写一份 message→row 的平行归约器。
// 合成事件是「视图重建」用途：只需产出与真实事件流「归约等价」的最小序列。
// v4 冷恢复只能重放 ProductProjection 认识的事件；如果 transcript 里的
// tool/reasoning/subagent/compact part 不反向合成，重启后历史可见运行态会从快照里消失。
import type {
  BackgroundResultOriginMeta,
  MessagePart,
  MessageWithParts,
  TurnInputIntentMetadata,
} from "@lcode/contracts";

import {
  conversationInputIntentSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
  type WorkflowLaunchMeta,
} from "@lcode/shared/lcode-protocol-v4";

/**
 * 中枢直接启动工作流的启动轮消息。核心持久化时写
 * `source: "workflow_launch"` + `metadata.workflowLaunch`（冷恢复的权威来源）。它是 synthetic
 * 但语义上属于用户真实动作的可见消息，共享投影 policy 会把 synthetic user 归成 hiddenSynthetic，
 * 因此 `isConversationRealUserTurnStarter` 认不出它；冷路径据本判据在 real-user 分支之前显式重建
 * 与活投影同形的 controlOnly 启动轮（TurnStarted{inputSource, workflowLaunch, executionKind} +
 * TurnComplete），而不是被当作隐藏 synthetic 跳过。畸形 / 缺席元数据回 null（退回既有跳过语义）。
 */
export function workflowLaunchOfMessage(message: MessageWithParts): WorkflowLaunchMeta | null {
  if (message.info.role !== "user") return null;
  if (message.info.source !== "workflow_launch") return null;
  const metadata = message.info.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = workflowLaunchMetaSchema.safeParse(
    (metadata as Record<string, unknown>).workflowLaunch,
  );
  return parsed.success ? parsed.data : null;
}

export function inputIntentOfMessage(
  message: MessageWithParts,
): TurnInputIntentMetadata | undefined {
  const fullIntent = conversationInputIntentSchema.safeParse(
    message.info.metadata?.conversationInputIntent,
  );
  if (fullIntent.success) {
    const value = fullIntent.data;
    return {
      sourceCommandId: value.sourceCommandId,
      queueItemId: value.queueItemId,
      clientId: value.clientId,
      kind: value.kind,
      // 可见 text 是展示事实；goal 的 canonical objective 只能读取持久 intent.text，
      // 禁止从 `/goal replace ...` 文案再做大小写/关键字解析。
      text: value.text,
      ...(value.modelSelection ? { modelSelection: value.modelSelection } : {}),
      ...(value.mode ? { mode: value.mode } : {}),
      ...(value.planEnabled !== undefined ? { planEnabled: value.planEnabled } : {}),
      admissionSeq: value.order.admissionSeq,
      admittedAt: value.admittedAt,
      requestedDelivery: value.delivery.requested,
      admittedDelivery: value.delivery.admitted,
      ...(value.order.queuePosition !== undefined
        ? { queuePosition: value.order.queuePosition }
        : {}),
      ...(value.delivery.fallbackReasonCode
        ? { fallbackReasonCode: value.delivery.fallbackReasonCode }
        : {}),
      ...(value.attachments.length > 0 ? { attachmentRefs: value.attachments } : {}),
      ...(value.provenance ? { provenance: value.provenance } : {}),
    };
  }

  // 兼容之前只持久化 metadata seed 的 transcript；新写入一律走上面的完整事实。
  const value = message.info.metadata?.inputIntent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const intent = value as Record<string, unknown>;
  if (
    typeof intent.sourceCommandId !== "string" ||
    typeof intent.queueItemId !== "string" ||
    typeof intent.clientId !== "string" ||
    (intent.kind !== "sendText" && intent.kind !== "sendGoalCommand") ||
    typeof intent.admissionSeq !== "number" ||
    typeof intent.admittedAt !== "number" ||
    (intent.requestedDelivery !== "auto" &&
      intent.requestedDelivery !== "startNow" &&
      intent.requestedDelivery !== "queue" &&
      intent.requestedDelivery !== "guide") ||
    (intent.admittedDelivery !== "startNow" &&
      intent.admittedDelivery !== "queue" &&
      intent.admittedDelivery !== "guide")
  ) {
    return undefined;
  }
  return value as TurnInputIntentMetadata;
}

export function executionKindOfMessage(
  message: MessageWithParts,
): "agent" | "controlOnly" | undefined {
  const value = message.info.metadata?.executionKind;
  return value === "agent" || value === "controlOnly" ? value : undefined;
}

/**
 * 引擎附加文本的起点：热路径它在 TurnStarted 上，
 * 冷路径从用户消息 metadata 读回同一个字段。只认非负整数——别的形状按缺席处理（宁可多显示）。
 */
export function epilogueStartOfMessage(message: MessageWithParts): number | undefined {
  const value = message.info.metadata?.epilogueStart;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 附件渲染：FilePart → TurnStarted 附件展示元信息（TurnAttachmentMeta）。
 * 冷订阅/fork-child 的历史附件由 transcript 反向合成——与 live 事件同一投影入口
 * （buildUserInputRow），保证冷/热路径行内容一致。
 */
export function attachmentMetasOfMessage(
  parts: readonly MessagePart[],
): Array<{ fileName: string; mime: string; bytes: number; ref?: string }> {
  const fileParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "file" }> => part.type === "file",
  );
  return fileParts.map((part, index) => {
    const urlIsStableRef = part.url.length > 0 && !part.url.startsWith("data:");
    const basenameFromUrl = urlIsStableRef ? (part.url.split(/[\\/]/).pop() ?? "") : "";
    return {
      fileName: part.filename ?? (basenameFromUrl || `attachment-${index + 1}`),
      mime: part.mime,
      bytes: part.metadata?.sizeBytes ?? 0,
      ...(urlIsStableRef ? { ref: part.url } : {}),
    };
  });
}

// ── model-only 唤醒轮──
// live 路径的 background wake / goal continuation 以 TurnStarted(inputVisibility=
// model-only) 开独立轮；冷路径不能把这类 synthetic user 跳过、让其后的 assistant 并进
// 上一轮——live/cold 必须结构一致。触发 source 由 shared projection policy
// 唯一维护；compact summary / rewind notice 等非触发型 synthetic context 照旧不开轮。

// ── guide steer 内联──
// drain 持久化的 user message 带 metadata.turnSteerDelivery：guide=内联当前轮
// （不是轮边界），queue=独立轮（真实 starter，与 live 切分一致）。legacy 无标记按 queue。
export function steerDeliveryOfMessage(message: MessageWithParts): "guide" | "queue" | null {
  if (message.info.role !== "user") return null;
  const metadata = (message.info as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = (metadata as Record<string, unknown>).turnSteerDelivery;
  return delivery === "guide" || delivery === "queue" ? delivery : null;
}

export function backgroundResultOriginMetaOfMessage(
  message: MessageWithParts,
): BackgroundResultOriginMeta | undefined {
  const messageMetadata = message.info.metadata;
  const partMetadata = message.parts.find((part) => part.type === "text")?.metadata;
  const candidate = messageMetadata?.originMeta ?? partMetadata?.originMeta;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const backgroundSource = record.backgroundSource;
  const workId = typeof record.workId === "string" ? record.workId.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  // 三个取值与 BackgroundResultOriginMeta 保持同步（contracts/src/events/session.events.ts）。
  // "workflow" 是 workflow run（workId ≡ runId）：漏掉它，workflow 的后台结果轮在冷恢复后会
  // 静默退化成一条无标题 model-only 消息，工具卡→详情页的关联键随之丢失。
  if (
    (backgroundSource !== "bash" &&
      backgroundSource !== "subagent" &&
      backgroundSource !== "workflow") ||
    !workId ||
    !title
  ) {
    return undefined;
  }
  // manifest 载荷（workflowNotification）也要过冷恢复：这里若只回读三基字段，冷恢复后
  // 载荷就丢了——manifest 条目退回裸标题行。用 shared 的 zod schema 校验，畸形就**只丢载荷**
  // 保基字段，绝不抛：这是投影重建路径，一个坏载荷不该打挂整条冷恢复。
  const workflowNotification = parseWorkflowNotificationMeta(record.workflowNotification);
  return {
    backgroundSource,
    title,
    workId,
    ...(workflowNotification ? { workflowNotification } : {}),
  };
}

/** 防御性解析 manifest 载荷：畸形 / 缺席都回 undefined（调用方据此让字段缺席），绝不抛。 */
function parseWorkflowNotificationMeta(
  value: unknown,
): BackgroundResultOriginMeta["workflowNotification"] {
  if (value === undefined || value === null) return undefined;
  const parsed = workflowNotificationMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
