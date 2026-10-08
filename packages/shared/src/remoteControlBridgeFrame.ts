/** 多设备桥接信封；设备侧帧不变，只有已协商的 Host↔Worker 使用此路由。 */
const MAGIC = [76, 67, 82, 77];
const MAX_PAYLOAD = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function validateId(deviceId: string): Uint8Array {
  const bytes = encoder.encode(deviceId);
  if (!bytes.length || bytes.length > 256 || decoder.decode(bytes) !== deviceId)
    throw new Error("invalid bridge deviceId");
  for (const char of deviceId) {
    const value = char.codePointAt(0) ?? 0;
    if (value <= 31 || value === 127) throw new Error("invalid bridge deviceId");
  }
  return bytes;
}
export function encodeRemoteControlBridgeFrame(deviceId: string, payload: Uint8Array): Uint8Array {
  const id = validateId(deviceId);
  if (payload.length > MAX_PAYLOAD) throw new Error("bridge payload too large");
  const frame = new Uint8Array(7 + id.length + payload.length);
  frame.set(MAGIC);
  frame[4] = 1;
  new DataView(frame.buffer).setUint16(5, id.length);
  frame.set(id, 7);
  frame.set(payload, 7 + id.length);
  return frame;
}
export function decodeRemoteControlBridgeFrame(frame: Uint8Array): {
  deviceId: string;
  payload: Uint8Array;
} {
  if (frame.length < 8 || MAGIC.some((value, offset) => frame[offset] !== value) || frame[4] !== 1)
    throw new Error("invalid bridge envelope");
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(5);
  if (
    !length ||
    length > 256 ||
    frame.length < 7 + length ||
    frame.length - 7 - length > MAX_PAYLOAD
  )
    throw new Error("invalid bridge envelope length");
  const deviceId = decoder.decode(frame.subarray(7, 7 + length));
  validateId(deviceId);
  return { deviceId, payload: frame.subarray(7 + length) };
}
