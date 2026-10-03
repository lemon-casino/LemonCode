import type {
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
} from "@lcode/shared/lcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  LCODE_ATTACHMENT_FAULT_CODES,
  LCodeAttachmentFaultError,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
} from "@lcode/shared/lcode-protocol-v4";
import { type V4GatewayState } from "./v4-gateway-state.js";
import {
  resolveReadableMediaAttachment,
  toShareStatFault,
} from "./v4-gateway-attachment-authorization.js";
import { readAttachmentPayload } from "./v4-gateway-binary-cache.js";

import { ensureColdReadyPublisher, hydratePublisher } from "./v4-gateway-hydration.js";

/** begin 只 admission metadata，不解码/暂存 full payload。 */
export async function attachmentBegin(
  gateway: Pick<V4GatewayState, "attachmentUploads" | "coldResume" | "host">,
  rawParams: unknown,
): Promise<V4AttachmentBeginResult> {
  const params = v4AttachmentBeginParamsSchema.parse(rawParams);
  // 粘贴曾通过预热创建工作树，随后上传又路由到原目录，触发 sessionNotFound。
  // 草稿 target 只写 artifact；真正的 session 仍保留 cold-resume 与归属校验。
  if (params.draftId) {
    if (!gateway.host.putDraftAttachment) throw new Error("fault.attachment.putUnsupported");
  } else {
    if (!gateway.host.putSessionAttachment || !params.sessionId) throw new Error("fault.attachment.putUnsupported");
    if (!gateway.host.sessionExists(params.sessionId)) await gateway.coldResume.ensureResumed(params.sessionId);
  }
  return gateway.attachmentUploads.begin(params);
}

export async function attachmentChunk(
  gateway: Pick<V4GatewayState, "attachmentUploads">,
  rawParams: unknown,
): Promise<V4AttachmentChunkResult> {
  return gateway.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
}

export function attachmentCommit(
  gateway: Pick<V4GatewayState, "attachmentUploads">,
  rawParams: unknown,
): Promise<V4AttachmentCommitResult> {
  return gateway.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
}

export async function attachmentAbort(
  gateway: Pick<V4GatewayState, "attachmentUploads">,
  rawParams: unknown,
): Promise<void> {
  await gateway.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
}

export async function attachmentRead(
  gateway: Pick<
    V4GatewayState,
    | "binaryReadCache"
    | "binaryReadCacheBytes"
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4AttachmentReadResult> {
  const params = v4AttachmentReadParamsSchema.parse(rawParams);
  if (!gateway.host.readSessionAttachment) {
    throw new Error("fault.attachment.readUnsupported");
  }
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !gateway.host.sessionExists(params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  const resolution = resolveReadableMediaAttachment(
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    // renderer 传来的 ref 不能直接成为文件路径；必须先由当前 session
    // 的权威 user row 证明归属，避免跨 session 或任意路径读取。
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }

  const payload = await readAttachmentPayload(
    gateway,
    params.sessionId,
    params.ref,
    resolution.attachment.mime,
    resolution.messageId,
    resolution.attachmentIndex,
  );
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return {
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  };
}

export async function conversationAttachmentRead(
  gateway: Pick<
    V4GatewayState,
    | "binaryReadCache"
    | "binaryReadCacheBytes"
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4ConversationAttachmentReadResult> {
  const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
  if (!gateway.host.readSessionAttachment) {
    throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
  }
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !gateway.host.sessionExists(params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let payload: { bytes: Uint8Array; mediaType: string };
  try {
    payload = await readAttachmentPayload(
      gateway,
      params.sessionId,
      params.ref,
      attachment.mime,
      messageId,
      params.attachmentIndex,
      true,
    );
  } catch (error) {
    throw toShareStatFault(error);
  }
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return v4ConversationAttachmentReadResultSchema.parse({
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  });
}

export async function conversationAttachmentStat(
  gateway: Pick<
    V4GatewayState,
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4ConversationAttachmentStatResult> {
  const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
  if (!gateway.host.statSessionAttachment) {
    throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
  }
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !gateway.host.sessionExists(params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let result: { totalBytes: number; mediaType: string; mtimeMs?: number };
  try {
    result = await gateway.host.statSessionAttachment(params.sessionId, {
      ref: params.ref,
      mime: attachment.mime,
      ...(messageId ? { messageId } : {}),
      attachmentIndex: params.attachmentIndex,
    });
  } catch (error) {
    // 「附件确实不在了」是 share 预检唯一能确定判定为跳过的分类，必须以稳定码上抛；
    // 否则 service 只能猜错误文本。
    throw toShareStatFault(error);
  }
  // stat 结果曾被 30MiB 的 schema 上限卡住，超大附件在这里抛 ZodError，
  // 于是 share 预检把「已知容量超限」这个确定阻断降级成 deferred 并静默丢内容。
  // 上限放宽后仍需要一个显式出口：真的超过协议可表达范围时给出稳定码。
  if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
    throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
  }
  return v4ConversationAttachmentStatResultSchema.parse(result);
}

export async function attachmentPreviewSource(
  gateway: Pick<
    V4GatewayState,
    | "coldResume"
    | "controlReservations"
    | "createLogEpoch"
    | "disposed"
    | "flushStates"
    | "host"
    | "hydratedSessions"
    | "hydrationBuffers"
    | "hydrationInFlight"
    | "indexPublishers"
    | "localTtft"
    | "now"
    | "pausedConnections"
    | "projectionEventCommitWaiters"
    | "publishers"
    | "rawSequenceStates"
    | "readyFlights"
  >,
  rawParams: unknown,
): Promise<V4AttachmentPreviewSourceResult> {
  const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
  const existingReady = gateway.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !gateway.host.sessionExists(params.sessionId)
      ? await ensureColdReadyPublisher(gateway, params.sessionId)
      : await hydratePublisher(gateway, params.sessionId);
  const resolution = resolveReadableMediaAttachment(
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }
  if (
    params.clientMode !== "desktop-continuous" ||
    !resolution.attachment.mime.startsWith("video/") ||
    !gateway.host.resolveSessionAttachmentPreviewSource
  ) {
    return { kind: "chunked" };
  }
  const result = await gateway.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
    ref: params.ref,
    mime: resolution.attachment.mime,
    ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
    ...(resolution.attachmentIndex !== undefined
      ? { attachmentIndex: resolution.attachmentIndex }
      : {}),
  });
  return v4AttachmentPreviewSourceResultSchema.parse(result);
}
