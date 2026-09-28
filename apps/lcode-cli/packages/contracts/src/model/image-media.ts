export type DetectedImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ParsedImageDataUrl {
  base64: string;
  data: Uint8Array;
  dataUrl: string;
  mediaType: string;
}

export interface ParseImageDataUrlOptions {
  allowWhitespace?: boolean;
}

export function detectImageMediaType(buffer: Uint8Array): DetectedImageMediaType | undefined {
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

export function parseImageDataUrl(
  value: string,
  options: ParseImageDataUrlOptions = {},
): ParsedImageDataUrl | undefined {
  const dataUrl = value.trim();
  const match = /^data:(image\/[a-z0-9.+_-]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!match?.[1] || !match[2]) return undefined;

  const rawBase64 = match[2];
  if (!options.allowWhitespace && /\s/.test(rawBase64)) return undefined;
  const base64 = options.allowWhitespace ? rawBase64.replace(/\s/g, "") : rawBase64;
  if (!isValidBase64Payload(base64)) return undefined;

  const data = Buffer.from(base64, "base64");
  if (data.byteLength === 0) return undefined;

  const mediaType = normalizeImageMediaType(match[1]);
  return {
    base64,
    data,
    dataUrl: `data:${mediaType};base64,${base64}`,
    mediaType,
  };
}

export function normalizeImageMediaType(value: string): string {
  const lower = value.toLowerCase();
  return lower === "image/jpg" ? "image/jpeg" : lower;
}

function isValidBase64Payload(value: string): boolean {
  return value.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
