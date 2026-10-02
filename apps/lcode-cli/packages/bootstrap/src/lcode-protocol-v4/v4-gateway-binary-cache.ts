import {
  PROTOCOL_V4_LIMITS,
  LCODE_ATTACHMENT_FAULT_CODES,
  LCodeAttachmentFaultError,
} from "@lcode/shared/lcode-protocol-v4";
import { type V4GatewayState } from "./v4-gateway-state.js";

/**
 * 一个产物版本的**整份**字节，带缓存。
 *
 * 端口的 `readArtifact` 返回的是整份字节，而
 * `workflowRunArtifactRead` 是**分块**查询——不缓存的话，一个 20 MiB 的 PDF 按 512 KiB
 * 分 40 块取，就会把整份文件从 store 读 40 遍（800 MiB 的 I/O），而且每一块都要重走一遍
 * journal 授权链。`attachmentRead` 早就有这张表，这里复用它（见 {@link BinaryReadCacheEntry}
 * 关于两个家族共用一张表的论证）。
 *
 * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
 * 同一次读，而不是各自发起一次再各自写一遍缓存。
 *
 * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
 * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
 * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
 *
 * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
 * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
 * 负缓存钉死 30 秒。
 */
export function readWorkflowArtifactPayload(
  gateway: Pick<V4GatewayState, "binaryReadCache" | "binaryReadCacheBytes" | "host" | "now">,
  params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  },
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = gateway.now();
  pruneBinaryReadCache(gateway, now);
  // 首段标签 `dwfart`：与附件预览共用同一张表，靠首段隔离（见 BinaryReadCacheEntry）。
  const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
  const cached = gateway.binaryReadCache.get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }

  const payload = gateway.host.readDynamicWorkflowRunArtifact!(params.sessionId, {
    runId: params.runId,
    artifactId: params.artifactId,
    version: params.version,
  })
    .then((artifact) => {
      if (artifact === undefined) {
        throw new Error(
          `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
        );
      }
      const current = gateway.binaryReadCache.get(key);
      if (current) {
        current.bytes = artifact.bytes.byteLength;
        gateway.binaryReadCacheBytes += artifact.bytes.byteLength;
        pruneBinaryReadCache(gateway, gateway.now());
      }
      // contentType 归一成表里的 mediaType 词汇；值仍是 journal 记录上的那一份
      // （UI 分派渲染器的精确匹配契约），不是 store 按文件名再推的那个。
      return { bytes: artifact.bytes, mediaType: artifact.contentType };
    })
    .catch((error: unknown) => {
      deleteBinaryReadCacheEntry(gateway, key);
      throw error;
    });
  gateway.binaryReadCache.set(key, {
    sessionId: params.sessionId,
    accessedAt: now,
    bytes: null,
    payload,
  });
  return payload;
}

/**
 * 读取附件全部字节（带 TTL/容量缓存）。
 *
 * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
 * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
 * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
 * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
 */
export function readAttachmentPayload(
  gateway: Pick<V4GatewayState, "binaryReadCache" | "binaryReadCacheBytes" | "host" | "now">,
  sessionId: string,
  ref: string,
  mime: string,
  messageId?: string,
  attachmentIndex?: number,
  allowGeneric = false,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = gateway.now();
  pruneBinaryReadCache(gateway, now);
  // 首段标签 `att`：这张表与 dwf 产物字节共用（见 BinaryReadCacheEntry），两个键空间
  // 只能靠一个不可能相等的首段隔离。
  const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
  const cached = gateway.binaryReadCache.get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }

  // 预览读取曾复用上传的 20MiB 总量上限；video 使用已有全局输入上限，
  // image 和上传事务继续保持原边界。
  const maxBytes = allowGeneric
    ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
    : mime.startsWith("video/")
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
  const payload = gateway.host.readSessionAttachment!(sessionId, {
    ref,
    mime,
    maxBytes,
    ...(messageId ? { messageId } : {}),
    ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
  })
    .then((result) => {
      const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        !allowGeneric &&
        !resultMime.startsWith("image/") &&
        !resultMime.startsWith("video/") &&
        resultMime !== "application/pdf"
      ) {
        throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
      }
      if (result.bytes.byteLength > maxBytes) {
        throw new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
      }
      const current = gateway.binaryReadCache.get(key);
      if (current) {
        current.bytes = result.bytes.byteLength;
        gateway.binaryReadCacheBytes += result.bytes.byteLength;
        pruneBinaryReadCache(gateway, gateway.now());
      }
      return result;
    })
    .catch((error) => {
      deleteBinaryReadCacheEntry(gateway, key);
      throw error;
    });
  gateway.binaryReadCache.set(key, { sessionId, accessedAt: now, bytes: null, payload });
  return payload;
}

export function pruneBinaryReadCache(
  gateway: Pick<V4GatewayState, "binaryReadCache" | "binaryReadCacheBytes" | "now">,
  now = gateway.now(),
): void {
  for (const [key, entry] of gateway.binaryReadCache) {
    if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
      deleteBinaryReadCacheEntry(gateway, key);
    }
  }
  if (gateway.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
  const oldest = [...gateway.binaryReadCache.entries()]
    .filter(([, entry]) => entry.bytes !== null)
    .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
  for (const [key] of oldest) {
    deleteBinaryReadCacheEntry(gateway, key);
    if (gateway.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
  }
}

export function deleteBinaryReadCacheEntry(
  gateway: Pick<V4GatewayState, "binaryReadCache" | "binaryReadCacheBytes">,
  key: string,
): void {
  const entry = gateway.binaryReadCache.get(key);
  if (!entry) return;
  gateway.binaryReadCache.delete(key);
  gateway.binaryReadCacheBytes = Math.max(0, gateway.binaryReadCacheBytes - (entry.bytes ?? 0));
}
