import { base64PayloadByteLength, isStrictBase64Payload } from "./attachment-data-url.js";

export const PDF_INPUT_MAX_BYTES = 20 * 1024 * 1024;

export function parseInlinePdfDataUrl(
  dataUrl: string,
): { mediaType: "application/pdf"; sizeBytes: number; bytes: Buffer } | undefined {
  const commaIndex = dataUrl.indexOf(",");
  if (dataUrl.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = dataUrl.slice("data:".length, commaIndex).split(";");
  const mediaType = headerParts.shift()?.trim().toLowerCase();
  const payload = dataUrl.slice(commaIndex + 1);
  if (
    mediaType !== "application/pdf" ||
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !isStrictBase64Payload(payload)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(payload, "base64");
  if (!isPdfBytes(bytes)) return undefined;
  return {
    mediaType: "application/pdf",
    sizeBytes: base64PayloadByteLength(payload),
    bytes,
  };
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}
