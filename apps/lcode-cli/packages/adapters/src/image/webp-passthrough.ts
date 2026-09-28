import {
  createImageProcessorError,
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
} from "@lcode/contracts";
import { createImageBudget, fitsImageBudget } from "./image-budget.js";

export function prepareWebpPassthrough(
  input: Buffer,
  request: ImagePrepareForModelRequest,
): ImagePrepareForModelResult {
  const budget = createImageBudget(request);
  if (!fitsImageBudget(input, budget)) {
    throw createImageProcessorError({
      code: "unsupported",
      message:
        "WebP image exceeds the model image budget and the current image adapter cannot transcode WebP",
    });
  }
  return {
    data: input,
    mediaType: "image/webp",
    originalSizeBytes: input.byteLength,
    resized: false,
    compressed: false,
    strategy: "original",
    transformedSizeBytes: input.byteLength,
  };
}
