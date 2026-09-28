import type { ImagePrepareForModelRequest } from "@lcode/contracts";
import { createImageProcessorError } from "@lcode/contracts";

export type ImageBudget = {
  maxBase64Bytes: number;
  maxRawBytes: number;
  maxTokens?: number;
  tokenToBase64CharRatio: number;
};

const DEFAULT_TOKEN_TO_BASE64_CHAR_RATIO = 0.125;

export function createImageBudget(request: ImagePrepareForModelRequest): ImageBudget {
  return {
    maxBase64Bytes: Math.floor(request.maxBase64Bytes),
    maxRawBytes: Math.floor(request.maxRawBytes),
    maxTokens: request.maxTokens,
    tokenToBase64CharRatio: request.tokenToBase64CharRatio ?? DEFAULT_TOKEN_TO_BASE64_CHAR_RATIO,
  };
}

export function validatePrepareRequest(request: ImagePrepareForModelRequest): void {
  if (!Number.isFinite(request.maxDimension) || request.maxDimension <= 0) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image resize maxDimension must be a positive finite number",
    });
  }
  if (!Number.isFinite(request.maxBase64Bytes) || request.maxBase64Bytes <= 0) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image maxBase64Bytes must be a positive finite number",
    });
  }
  if (!Number.isFinite(request.maxRawBytes) || request.maxRawBytes <= 0) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image maxRawBytes must be a positive finite number",
    });
  }
}

export function fitsImageBudget(buffer: Buffer, budget: ImageBudget): boolean {
  const base64Bytes = base64EncodedLength(buffer.byteLength);
  if (buffer.byteLength > budget.maxRawBytes) return false;
  if (base64Bytes > budget.maxBase64Bytes) return false;
  if (budget.maxTokens === undefined) return true;
  return Math.ceil(base64Bytes * budget.tokenToBase64CharRatio) <= budget.maxTokens;
}

function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}
