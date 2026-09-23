// 官方帧契约的开源实现：栅格 + 紧随其后的引用文本 + integrity _meta 三件套。
// 线格式（本仓库唯一定义点，producer 与消费方共同遵守）：
//   引用文本是一个紧凑 JSON 对象，逐字段校验，任何字段缺失/多余类型不匹配都不算官方帧引用：
//   { type:"zcode_cua_frame_ref", schemaVersion:1, authority:"zcode.cua/open-frame/<scope>",
//     frameId:<非空串>, contentProtection:"official_cua_frame_v1", mimeType?, width?, height?,
//     envelopeAlgorithm?, appRef? }
// 安全边界说明：integrity meta 与引用文本不含密钥、不构成防伪造签名。开源 build 里它的
// 作用是把「本 runtime 真实截取的栅格」与第三方随机图片区分开，让 core 归一化层走
// exact-raster 保留路径（坐标契约不被压缩/落盘路径破坏）；特权判定（permission capability
// group 等）只认 server 白名单（core registerMcpTools 的 officialCuaServerNames），
// 不认本 _meta，帧标记因此不构成提权面。

export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";

export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

const OFFICIAL_CUA_IMAGE_INLINE_RAW_BYTES = Math.floor(
  (OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES * 3) / 4,
);

// 引用文本的 wire 常量。type 令牌全局唯一，凭据类包含检查用它，避免脆弱的 JSON 片段匹配。
const FRAME_REF_TYPE = "zcode_cua_frame_ref";
const FRAME_REF_AUTHORITY_PREFIX = "zcode.cua/open-frame";
const FRAME_REF_AUTHORITY_NAMESPACE = `${FRAME_REF_AUTHORITY_PREFIX}/`;
const FRAME_REF_SCHEMA_VERSION = 1;
const FRAME_REF_KEYS = new Set([
  "type",
  "schemaVersion",
  "authority",
  "frameId",
  "contentProtection",
  "mimeType",
  "width",
  "height",
  "envelopeAlgorithm",
  "appRef",
]);
// 引用文本的长度上限：合法引用远小于此；超长直接按非引用处理，避免对超大国块做 JSON.parse。
const FRAME_REF_MAX_TEXT_LENGTH = 4096;
// 压缩官方帧时的模型侧尺寸上限（与 core HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION 同值，
// 但独立定义：provider 2000px 上限的归属在各自层，避免倒置耦合）。
const FRAME_MODEL_IMAGE_MAX_DIMENSION = 2000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFrameAppRef(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["pid", "bundle_id", "name", "window_id"].includes(key))) return false;
  const hasPid = Number.isSafeInteger(value.pid) && value.pid > 0;
  const hasBundleId =
    typeof value.bundle_id === "string" &&
    value.bundle_id.length > 0 &&
    value.bundle_id.trim() === value.bundle_id;
  const hasName =
    typeof value.name === "string" && value.name.length > 0 && value.name.trim() === value.name;
  if (!hasPid && !hasBundleId && !hasName) return false;
  if (value.pid !== undefined && !hasPid) return false;
  if (value.bundle_id !== undefined && !hasBundleId) return false;
  if (value.name !== undefined && !hasName) return false;
  return (
    value.window_id === undefined || (Number.isSafeInteger(value.window_id) && value.window_id >= 0)
  );
}

// 解析并严格校验引用文本；非法返回 undefined。所有判定函数共享这一个入口。
function parseFrameRef(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > FRAME_REF_MAX_TEXT_LENGTH) {
    return undefined;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  if (!Object.keys(value).every((key) => FRAME_REF_KEYS.has(key))) return undefined;
  if (value.type !== FRAME_REF_TYPE) return undefined;
  if (value.schemaVersion !== FRAME_REF_SCHEMA_VERSION) return undefined;
  // Bug 根因：startsWith(prefix) 会把 open-frameevil 也当成官方命名空间；必须要求斜杠边界及非空 scope。
  if (
    typeof value.authority !== "string" ||
    !value.authority.startsWith(FRAME_REF_AUTHORITY_NAMESPACE) ||
    value.authority.length === FRAME_REF_AUTHORITY_NAMESPACE.length ||
    value.authority.trim() !== value.authority
  ) {
    return undefined;
  }
  if (
    typeof value.frameId !== "string" ||
    value.frameId.length === 0 ||
    value.frameId.trim() !== value.frameId
  ) {
    return undefined;
  }
  if (value.contentProtection !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION) return undefined;
  if (
    value.mimeType !== undefined &&
    (typeof value.mimeType !== "string" || !value.mimeType.startsWith("image/"))
  ) {
    return undefined;
  }
  const hasWidth = value.width !== undefined;
  const hasHeight = value.height !== undefined;
  if (hasWidth !== hasHeight) return undefined;
  if (hasWidth && (!Number.isSafeInteger(value.width) || value.width <= 0)) return undefined;
  if (hasHeight && (!Number.isSafeInteger(value.height) || value.height <= 0)) return undefined;
  if (value.envelopeAlgorithm !== undefined) {
    if (
      typeof value.envelopeAlgorithm !== "string" ||
      !hasWidth ||
      !hasHeight ||
      value.mimeType !== "image/png"
    ) {
      return undefined;
    }
    const envelope = readRasterEnvelopeIdentity({
      width: value.width,
      height: value.height,
      mimeType: value.mimeType,
    });
    if (!envelope || value.envelopeAlgorithm !== envelope.algorithm) return undefined;
  }
  if (value.appRef !== undefined && !isFrameAppRef(value.appRef)) return undefined;
  return value;
}

export function isOfficialCuaImageRefText(text) {
  return parseFrameRef(text) !== undefined;
}

export function containsOfficialCuaImageRefCredentialText(text) {
  return typeof text === "string" && text.includes(FRAME_REF_TYPE);
}

export function containsImageRefAuthority(text) {
  return typeof text === "string" && text.includes(FRAME_REF_AUTHORITY_PREFIX);
}

export function parseOfficialCuaImageRef(text) {
  const ref = parseFrameRef(text);
  return ref ? { authority: ref.authority } : undefined;
}

// 栅格信封标识：producer 截图结果（宽高 + PNG mime）的确定性描述，进引用文本与
// integrity meta，供下游核对坐标契约对应的栅格形状。形状非法返回 undefined。
export function readRasterEnvelopeIdentity(input) {
  if (!isPlainObject(input)) return undefined;
  const { width, height, mimeType } = input;
  if (!Number.isSafeInteger(width) || width <= 0) return undefined;
  if (!Number.isSafeInteger(height) || height <= 0) return undefined;
  if (mimeType !== "image/png") return undefined;
  return { algorithm: `png-raster-envelope-v1/${width}x${height}` };
}

export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return undefined;
  for (let index = 0; index < content.length - 1; index += 1) {
    const image = content[index];
    const ref = content[index + 1];
    if (
      isPlainObject(image) &&
      image.type === "image" &&
      isPlainObject(ref) &&
      ref.type === "text" &&
      isOfficialCuaImageRefText(ref.text)
    ) {
      const parsedRef = parseFrameRef(ref.text);
      const blockMimeType =
        typeof image.mimeType === "string"
          ? image.mimeType
          : typeof image.mediaType === "string"
            ? image.mediaType
            : undefined;
      const dataUrlMatch =
        typeof image.dataUrl === "string" ? /^data:([^;,]+)[;,]/u.exec(image.dataUrl) : undefined;
      const dataUrlMimeType = dataUrlMatch?.[1];
      const hasRawData = typeof image.data === "string" && image.data.length > 0;
      const hasDataUrl = typeof image.dataUrl === "string" && dataUrlMatch !== null;
      // Bug 根因：只检查相邻 block 类型会接受 PNG ref + JPEG 栅格，模型坐标契约并未绑定真实图片。
      if (
        !parsedRef ||
        (!hasRawData && !hasDataUrl) ||
        (typeof image.mimeType === "string" &&
          typeof image.mediaType === "string" &&
          image.mimeType !== image.mediaType) ||
        (parsedRef.mimeType !== undefined && blockMimeType !== parsedRef.mimeType) ||
        (dataUrlMimeType !== undefined && blockMimeType !== dataUrlMimeType)
      ) {
        continue;
      }
      return { image, imageRef: ref, imageIndex: index, imageRefIndex: index + 1 };
    }
  }
  return undefined;
}

export function attestOfficialCuaFrameContent(content, expectedKind) {
  const kind =
    typeof expectedKind === "string" && expectedKind.length > 0
      ? expectedKind
      : OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION;
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  const ref = parseFrameRef(pair.imageRef.text);
  if (!ref || ref.contentProtection !== kind) return undefined;
  return { kind };
}

// 压缩超限的官方帧栅格：复用宿主注入的 imageProcessorPort（与 core 归一化同一端口形状），
// 压缩失败/端口缺失时原样保留（保留路径的底线是块不被丢弃，不是尺寸必然达标）。
async function compressFrameImage(port, base64, mimeType, signal) {
  if (!isPlainObject(port) || typeof port.prepareForModel !== "function") return undefined;
  try {
    const prepared = await port.prepareForModel(
      {
        data: Buffer.from(base64, "base64"),
        maxBase64Bytes: OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES,
        // 项目 ImageProcessorPort 的预算必须同时约束原始字节与 base64 字节；漏传会被真实端口拒绝。
        maxRawBytes: OFFICIAL_CUA_IMAGE_INLINE_RAW_BYTES,
        maxDimension: FRAME_MODEL_IMAGE_MAX_DIMENSION,
        mediaType: typeof mimeType === "string" && mimeType ? mimeType : "image/png",
      },
      { signal },
    );
    if (!isPlainObject(prepared)) return undefined;
    const data = Buffer.from(prepared.data).toString("base64");
    if (data.length === 0 || data.length > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES) return undefined;
    if (typeof prepared.mediaType !== "string" || !prepared.mediaType.startsWith("image/")) {
      return undefined;
    }
    if (!Number.isSafeInteger(prepared.width) || prepared.width <= 0) return undefined;
    if (!Number.isSafeInteger(prepared.height) || prepared.height <= 0) return undefined;
    return { data, mimeType: prepared.mediaType, width: prepared.width, height: prepared.height };
  } catch (error) {
    // 取消要继续上抛（与 core 归一化层同一语义）；普通压缩失败按「保留原图」处理。
    if (signal?.aborted) throw error;
    return undefined;
  }
}

// 压缩会改变栅格尺寸；引用文本携带的宽高是模型的坐标契约，必须同步改写，
// 否则压缩后模型按旧坐标系出坐标、指针系统性偏移。改写失败原样返回旧引用。
function refWithRasterEnvelope(refText, width, height, mimeType) {
  if (!Number.isSafeInteger(width) || width <= 0) return refText;
  if (!Number.isSafeInteger(height) || height <= 0) return refText;
  if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) return refText;
  try {
    const ref = JSON.parse(refText.text);
    if (!isPlainObject(ref)) return refText;
    ref.width = width;
    ref.height = height;
    ref.mimeType = mimeType;
    const envelope = readRasterEnvelopeIdentity({ width, height, mimeType });
    if (envelope) ref.envelopeAlgorithm = envelope.algorithm;
    else delete ref.envelopeAlgorithm;
    return { type: "text", text: JSON.stringify(ref) };
  } catch {
    return refText;
  }
}

function metaWithRasterEnvelope(meta, width, height, mimeType) {
  if (!isPlainObject(meta)) return meta;
  const integrity = meta[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY];
  if (!isPlainObject(integrity)) return meta;
  const nextIntegrity = { ...integrity };
  const envelope = readRasterEnvelopeIdentity({ width, height, mimeType });
  if (envelope) nextIntegrity.envelopeAlgorithm = envelope.algorithm;
  else delete nextIntegrity.envelopeAlgorithm;
  return { ...meta, [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: nextIntegrity };
}

export async function preserveOfficialCuaFrameResult(result, options) {
  const content = result?.content;
  if (!Array.isArray(content)) return result;
  const port = isPlainObject(options) ? options.imageProcessorPort : undefined;
  const signal = isPlainObject(options) ? options.signal : undefined;
  const nextContent = [];
  let changed = false;
  let nextMeta = result?._meta;
  for (let index = 0; index < content.length; index += 1) {
    const image = content[index];
    const ref = content[index + 1];
    const isPair =
      isPlainObject(image) &&
      image.type === "image" &&
      typeof image.data === "string" &&
      isPlainObject(ref) &&
      ref.type === "text" &&
      isOfficialCuaImageRefText(ref.text);
    if (!isPair) {
      nextContent.push(image);
      continue;
    }
    let nextImage = image;
    let nextRef = ref;
    if (Buffer.byteLength(image.data, "utf8") > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES) {
      const compressed = await compressFrameImage(port, image.data, image.mimeType, signal);
      if (compressed) {
        nextImage = { type: "image", data: compressed.data, mimeType: compressed.mimeType };
        nextRef = refWithRasterEnvelope(
          ref,
          compressed.width,
          compressed.height,
          compressed.mimeType,
        );
        nextMeta = metaWithRasterEnvelope(
          nextMeta,
          compressed.width,
          compressed.height,
          compressed.mimeType,
        );
      }
    }
    nextContent.push(nextImage, nextRef);
    if (nextImage !== image || nextRef !== ref) changed = true;
    index += 1;
  }
  // official 路径只允许超限压缩；压缩改变栅格时，ref 与 integrity envelope 必须同步描述新栅格。
  return changed
    ? { ...result, content: nextContent, ...(nextMeta === undefined ? {} : { _meta: nextMeta }) }
    : result;
}
