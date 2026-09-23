// 最小 RGB PNG 编码器（仅 colortype 2 / 8bit / filter 0）。
// 为什么不用 jimp：nut-js 依赖树里虽有 jimp@0.22，但那是传递依赖，API 随大版本漂移；
// 截屏编码只需要的确定的 zlib + CRC32 组合，node:zlib 自含即可，保持本包零第三方图像依赖。
import { deflateSync } from "node:zlib";

function deflate(raw) {
  return deflateSync(raw, { level: 6 });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * 把 width*height*3 的 RGB 像素编码为 PNG Buffer。
 * rgb 长度必须恰为 width*height*3，行主序、无行填充。
 */
export function encodeRgbPng(width, height, rgb) {
  const stride = width * 3;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("PNG dimensions must be positive integers");
  }
  if (rgb.length !== stride * height) {
    throw new Error("PNG pixel buffer size mismatch");
  }
  // 每行前置 1 字节 filter 类型（0 = None）。
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
