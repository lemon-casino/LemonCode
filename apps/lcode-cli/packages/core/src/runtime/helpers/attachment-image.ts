import {
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_TARGET_BYTES,
  type ImageProcessorPort,
  type TraceContext,
} from "../deps.js";
import { MAX_IMAGE_ATTACHMENT_DIMENSION } from "../types.js";
import type { PreparedImageData } from "../types.js";

export async function prepareImageDataUrl(
  dataUrl: string,
  mediaType: string,
  options: {
    abortSignal?: AbortSignal;
    imageProcessorPort?: ImageProcessorPort;
    traceContext: TraceContext;
  },
): Promise<PreparedImageData | undefined> {
  const base64Data = parseBase64DataUrlPayload(dataUrl);
  if (!base64Data) return undefined;
  if (!options.imageProcessorPort) {
    return { dataUrl, mediaType };
  }

  const prepared = await options.imageProcessorPort.prepareForModel(
    {
      data: Buffer.from(base64Data, "base64"),
      maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
      maxDimension: MAX_IMAGE_ATTACHMENT_DIMENSION,
      maxRawBytes: READ_IMAGE_TARGET_BYTES,
      mediaType,
      trace: options.traceContext,
    },
    { signal: options.abortSignal },
  );
  const resizedData = Buffer.from(prepared.data);
  const resizedMediaType = prepared.mediaType || mediaType;
  return {
    dataUrl: `data:${resizedMediaType};base64,${resizedData.toString("base64")}`,
    mediaType: resizedMediaType,
    metadata: {
      height: prepared.height,
      maxDimension: MAX_IMAGE_ATTACHMENT_DIMENSION,
      originalHeight: prepared.originalHeight,
      originalWidth: prepared.originalWidth,
      resized: prepared.resized,
      transformedSizeBytes: prepared.transformedSizeBytes,
      width: prepared.width,
    },
  };
}

function parseBase64DataUrlPayload(dataUrl: string): string | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  const data = match?.[2];
  if (!match || !data) return undefined;
  return data;
}

export function inferImageMimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}
