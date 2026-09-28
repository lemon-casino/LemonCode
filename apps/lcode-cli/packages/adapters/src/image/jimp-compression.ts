import { Jimp, JimpMime, ResizeStrategy } from "jimp";
import {
  createImageProcessorError,
  type ImageCompressionStrategy,
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
} from "@lcode/contracts";
import {
  detectImageMediaType,
  jimpOutputMediaType,
  normalizeMediaType,
  throwIfAborted,
} from "./jimp-media.js";
import {
  createImageBudget,
  fitsImageBudget,
  validatePrepareRequest,
  type ImageBudget,
} from "./image-budget.js";
import { prepareWebpPassthrough } from "./webp-passthrough.js";

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

type ImageCandidate = {
  data: Buffer;
  height?: number;
  mediaType: string;
  strategy: ImageCompressionStrategy;
  width?: number;
};

const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;
const PROGRESSIVE_SCALE_FACTORS = [0.75, 0.5, 0.25] as const;
const AGGRESSIVE_JPEG_MAX_EDGES = [1000, 800, 600, 400, 300, 200] as const;
const MIN_IMAGE_EDGE = 1;

export async function prepareJimpImageForModel(
  request: ImagePrepareForModelRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ImagePrepareForModelResult> {
  throwIfAborted(options.signal);
  validatePrepareRequest(request);

  const input = Buffer.from(request.data);
  if (input.byteLength === 0) {
    throw createImageProcessorError({
      code: "empty",
      message: "Image file is empty (0 bytes)",
    });
  }

  const detectedMediaType =
    detectImageMediaType(input) ?? normalizeMediaType(request.mediaType);
  if (detectedMediaType === "image/webp") {
    return prepareWebpPassthrough(input, request);
  }

  let image: JimpImage;
  try {
    image = await Jimp.read(input);
  } catch (cause) {
    throw createImageProcessorError({
      code: "processing_failed",
      message: "Unable to decode image data",
      cause,
    });
  }
  throwIfAborted(options.signal);

  const originalWidth = image.bitmap.width;
  const originalHeight = image.bitmap.height;
  const budget = createImageBudget(request);
  const sourceMediaType = normalizeMediaType(detectedMediaType);

  if (
    originalWidth <= request.maxDimension &&
    originalHeight <= request.maxDimension &&
    fitsImageBudget(input, budget)
  ) {
    return {
      data: input,
      mediaType: sourceMediaType,
      originalHeight,
      originalSizeBytes: input.byteLength,
      originalWidth,
      height: originalHeight,
      width: originalWidth,
      resized: false,
      compressed: false,
      strategy: "original",
      transformedSizeBytes: input.byteLength,
    };
  }

  const candidate = await findFirstFittingCandidate({
    budget,
    image,
    maxDimension: request.maxDimension,
    signal: options.signal,
    sourceMediaType,
  });

  if (candidate) {
    return candidateToResult(candidate, {
      input,
      originalHeight,
      originalWidth,
      sourceMediaType,
    });
  }

  throw createImageProcessorError({
    code: "too_large",
    message: `Unable to compress image (${input.byteLength} bytes) within the requested model image budget`,
  });
}

async function findFirstFittingCandidate(input: {
  budget: ImageBudget;
  image: JimpImage;
  maxDimension: number;
  signal?: AbortSignal;
  sourceMediaType: string;
}): Promise<ImageCandidate | undefined> {
  const originalWithinDimensions =
    input.image.bitmap.width <= input.maxDimension &&
    input.image.bitmap.height <= input.maxDimension;
  // PNG 原尺寸优化失败后，旧策略会在每个缩放档重新尝试 PNG，导致较大尺寸 JPEG
  // 尚可满足预算时先命中低分辨率 PNG。PNG 只保留一次原尺寸无损优化机会；失败后单向转 JPEG。
  const preserveSourceFormatAfterInitialAttempt =
    input.sourceMediaType !== JimpMime.png;

  if (originalWithinDimensions) {
    const candidate = await findFormatPreservingCandidate(
      input.image,
      input.sourceMediaType,
      input.budget,
      input.signal,
    );
    if (candidate) return candidate;
  }

  const boundedImage = resizeToMaxEdge(input.image, input.maxDimension);
  if (
    preserveSourceFormatAfterInitialAttempt &&
    !sameDimensions(input.image, boundedImage)
  ) {
    const candidate = await fitCandidate(
      encodeCandidate(
        boundedImage,
        input.sourceMediaType,
        "resized",
        input.signal,
      ),
      input.budget,
    );
    if (candidate) return candidate;
  }

  if (!originalWithinDimensions && preserveSourceFormatAfterInitialAttempt) {
    const boundedFormatCandidate = await findFormatPreservingCandidate(
      boundedImage,
      input.sourceMediaType,
      input.budget,
      input.signal,
    );
    if (boundedFormatCandidate) return boundedFormatCandidate;
  }

  const boundedJpegCandidate = await findJpegQualityCandidate(
    boundedImage,
    input.budget,
    input.signal,
  );
  if (boundedJpegCandidate) return boundedJpegCandidate;

  for (const scale of PROGRESSIVE_SCALE_FACTORS) {
    const scaled = resizeToMaxEdge(
      boundedImage,
      Math.max(MIN_IMAGE_EDGE, Math.round(longestEdge(boundedImage) * scale)),
    );
    if (preserveSourceFormatAfterInitialAttempt) {
      const formatCandidate = await findFormatPreservingCandidate(
        scaled,
        input.sourceMediaType,
        input.budget,
        input.signal,
      );
      if (formatCandidate) return formatCandidate;
    }

    const jpegCandidate = await findJpegQualityCandidate(
      scaled,
      input.budget,
      input.signal,
    );
    if (jpegCandidate) return jpegCandidate;
  }

  for (const maxEdge of AGGRESSIVE_JPEG_MAX_EDGES) {
    const scaled = resizeToMaxEdge(
      input.image,
      Math.min(maxEdge, input.maxDimension),
    );
    const candidate = await fitCandidate(
      encodeJpegCandidate(scaled, 20, "jpeg-fallback", input.signal),
      input.budget,
    );
    if (candidate) return candidate;
  }

  return undefined;
}

async function findFormatPreservingCandidate(
  image: JimpImage,
  mediaType: string,
  budget: ImageBudget,
  signal?: AbortSignal,
): Promise<ImageCandidate | undefined> {
  throwIfAborted(signal);
  if (mediaType === "image/png") {
    return fitCandidate(
      encodePngCandidate(image, "png-optimized", signal),
      budget,
    );
  }
  if (mediaType === "image/jpeg") {
    return findJpegQualityCandidate(image, budget, signal);
  }
  if (mediaType === "image/gif") {
    return fitCandidate(
      encodeCandidate(image, "image/gif", "preserve-format", signal),
      budget,
    );
  }
  return undefined;
}

async function findJpegQualityCandidate(
  image: JimpImage,
  budget: ImageBudget,
  signal?: AbortSignal,
): Promise<ImageCandidate | undefined> {
  for (const quality of JPEG_QUALITY_STEPS) {
    const candidate = await fitCandidate(
      encodeJpegCandidate(image, quality, "jpeg-quality", signal),
      budget,
    );
    if (candidate) return candidate;
  }
  return undefined;
}

async function fitCandidate(
  candidatePromise: Promise<ImageCandidate>,
  budget: ImageBudget,
): Promise<ImageCandidate | undefined> {
  const candidate = await candidatePromise;
  return fitsImageBudget(candidate.data, budget) ? candidate : undefined;
}

async function encodeCandidate(
  image: JimpImage,
  mediaType: string,
  strategy: ImageCompressionStrategy,
  signal?: AbortSignal,
): Promise<ImageCandidate> {
  throwIfAborted(signal);
  const outputMediaType = jimpOutputMediaType(mediaType, image.mime);
  const data = await image.getBuffer(outputMediaType);
  throwIfAborted(signal);
  return {
    data,
    mediaType: outputMediaType,
    strategy,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

async function encodePngCandidate(
  image: JimpImage,
  strategy: ImageCompressionStrategy,
  signal?: AbortSignal,
): Promise<ImageCandidate> {
  throwIfAborted(signal);
  const data = await image.getBuffer(JimpMime.png, {
    deflateLevel: 9,
    deflateStrategy: 3,
  });
  throwIfAborted(signal);
  return {
    data,
    mediaType: JimpMime.png,
    strategy,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

async function encodeJpegCandidate(
  image: JimpImage,
  quality: number,
  strategy: ImageCompressionStrategy,
  signal?: AbortSignal,
): Promise<ImageCandidate> {
  throwIfAborted(signal);
  const data = await image.getBuffer(JimpMime.jpeg, { quality });
  throwIfAborted(signal);
  return {
    data,
    mediaType: JimpMime.jpeg,
    strategy,
    width: image.bitmap.width,
    height: image.bitmap.height,
  };
}

function candidateToResult(
  candidate: ImageCandidate,
  input: {
    input: Buffer;
    originalHeight: number;
    originalWidth: number;
    sourceMediaType: string;
  },
): ImagePrepareForModelResult {
  const resized =
    candidate.width !== undefined &&
    candidate.height !== undefined &&
    (candidate.width !== input.originalWidth ||
      candidate.height !== input.originalHeight);
  return {
    data: candidate.data,
    mediaType: normalizeMediaType(candidate.mediaType),
    originalHeight: input.originalHeight,
    originalSizeBytes: input.input.byteLength,
    originalWidth: input.originalWidth,
    height: candidate.height,
    width: candidate.width,
    resized,
    compressed:
      candidate.data.byteLength < input.input.byteLength ||
      normalizeMediaType(candidate.mediaType) !== input.sourceMediaType,
    strategy: candidate.strategy,
    transformedSizeBytes: candidate.data.byteLength,
  };
}

function resizeToMaxEdge(image: JimpImage, maxEdge: number): JimpImage {
  const clone = image.clone();
  if (longestEdge(clone) <= maxEdge) return clone;
  clone.scaleToFit({
    h: maxEdge,
    mode: ResizeStrategy.BICUBIC,
    w: maxEdge,
  });
  return clone;
}

function sameDimensions(left: JimpImage, right: JimpImage): boolean {
  return (
    left.bitmap.width === right.bitmap.width &&
    left.bitmap.height === right.bitmap.height
  );
}

function longestEdge(image: JimpImage): number {
  return Math.max(image.bitmap.width, image.bitmap.height);
}
