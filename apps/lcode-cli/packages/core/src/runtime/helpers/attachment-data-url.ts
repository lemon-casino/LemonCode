export function parseDataUrlHeader(dataUrl: string): { mediaType: string } | undefined {
  const commaIndex = dataUrl.indexOf(",");
  if (dataUrl.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const mediaType = dataUrl.slice("data:".length, commaIndex).split(";", 1)[0]?.trim();
  return mediaType ? { mediaType: mediaType.toLowerCase() } : undefined;
}

/** base64 正文对应的原始字节数（无需解码）。 */
export function base64PayloadByteLength(payload: string): number {
  // base64 末尾的 padding 不代表内容字节；扣除它，避免上限处的合法媒体被多算 1–2 字节。
  const paddingBytes = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - paddingBytes;
}

export function isStrictBase64Payload(payload: string): boolean {
  if (payload.length === 0) return true;
  if (payload.length % 4 !== 0) return false;
  const paddingBytes = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const contentLength = payload.length - paddingBytes;
  for (let index = 0; index < contentLength; index += 1) {
    const code = payload.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  for (let index = contentLength; index < payload.length; index += 1) {
    if (payload.charCodeAt(index) !== 61) return false;
  }
  return true;
}
