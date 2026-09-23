// 官方帧契约单测：引用文本严格解析、凭据包含检查、配对、attestation、保留路径压缩。
import assert from "node:assert/strict";
import test from "node:test";
import {
  attestOfficialCuaFrameContent,
  containsImageRefAuthority,
  containsOfficialCuaImageRefCredentialText,
  findOfficialCuaFrameContentPair,
  isOfficialCuaImageRefText,
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES,
  parseOfficialCuaImageRef,
  preserveOfficialCuaFrameResult,
  readRasterEnvelopeIdentity,
} from "./frame-contract.js";

function frameRef(overrides = {}) {
  return JSON.stringify({
    type: "zcode_cua_frame_ref",
    schemaVersion: 1,
    authority: "zcode.cua/open-frame/local-driver",
    frameId: "frame-1",
    contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    mimeType: "image/png",
    width: 2560,
    height: 1440,
    ...overrides,
  });
}

function framePair(base64 = "c2hvdA==", overrides = {}) {
  return [
    { type: "image", data: base64, mimeType: "image/png" },
    { type: "text", text: frameRef(overrides) },
  ];
}

test("引用文本：合法全真，逐字段严格", () => {
  assert.ok(isOfficialCuaImageRefText(frameRef()));
  assert.ok(isOfficialCuaImageRefText(frameRef({ appRef: { pid: 42, window_id: 7 } })));
  assert.ok(
    isOfficialCuaImageRefText(frameRef({ envelopeAlgorithm: "png-raster-envelope-v1/2560x1440" })),
  );
  assert.equal(
    parseOfficialCuaImageRef(frameRef())?.authority,
    "zcode.cua/open-frame/local-driver",
  );
  // 非 JSON、非对象、type/schemaVersion/authority/frameId/contentProtection 任一不对都拒绝
  assert.ok(!isOfficialCuaImageRefText("not json"));
  assert.ok(!isOfficialCuaImageRefText("prose mentioning zcode_cua_frame_ref in text"));
  assert.ok(
    !isOfficialCuaImageRefText(JSON.stringify({ ...JSON.parse(frameRef()), type: "other" })),
  );
  assert.ok(
    !isOfficialCuaImageRefText(JSON.stringify({ ...JSON.parse(frameRef()), schemaVersion: 2 })),
  );
  assert.ok(
    !isOfficialCuaImageRefText(JSON.stringify({ ...JSON.parse(frameRef()), authority: "evil" })),
  );
  assert.ok(!isOfficialCuaImageRefText(frameRef({ authority: "zcode.cua/open-frameevil" })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ authority: "zcode.cua/open-frame/" })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ authority: "zcode.cua/open-frame" })));
  assert.ok(!isOfficialCuaImageRefText(JSON.stringify({ ...JSON.parse(frameRef()), frameId: "" })));
  assert.ok(
    !isOfficialCuaImageRefText(
      JSON.stringify({ ...JSON.parse(frameRef()), contentProtection: "other" }),
    ),
  );
  assert.ok(!isOfficialCuaImageRefText(frameRef({ appRef: { window_id: 7 } })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ appRef: { pid: -1 } })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ appRef: { pid: 42, unexpected: true } })));
  assert.ok(isOfficialCuaImageRefText(frameRef({ mimeType: "image/jpeg" })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ mimeType: "text/plain" })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ mimeType: 42 })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ width: 0 })));
  assert.ok(!isOfficialCuaImageRefText(frameRef({ height: undefined })));
  assert.ok(
    !isOfficialCuaImageRefText(frameRef({ envelopeAlgorithm: "png-raster-envelope-v1/1280x720" })),
  );
  assert.ok(!isOfficialCuaImageRefText(frameRef({ unexpected: true })));
  assert.ok(!isOfficialCuaImageRefText("[1,2,3]"));
  assert.ok(!isOfficialCuaImageRefText(42));
});

test("凭据包含与 authority 包含：引用令牌/前缀命中，普通文本不误杀", () => {
  assert.ok(containsOfficialCuaImageRefCredentialText(`前言 ${frameRef()} 后记`));
  assert.ok(containsImageRefAuthority("see zcode.cua/open-frame for details"));
  assert.ok(!containsOfficialCuaImageRefCredentialText("an ordinary sentence"));
  assert.ok(!containsImageRefAuthority("an ordinary sentence"));
});

test("栅格信封标识：宽高 + PNG mime 合法，其余拒绝", () => {
  assert.deepEqual(
    readRasterEnvelopeIdentity({ width: 2560, height: 1440, mimeType: "image/png" }),
    {
      algorithm: "png-raster-envelope-v1/2560x1440",
    },
  );
  assert.equal(
    readRasterEnvelopeIdentity({ width: 0, height: 10, mimeType: "image/png" }),
    undefined,
  );
  assert.equal(
    readRasterEnvelopeIdentity({ width: 10, height: 10, mimeType: "image/jpeg" }),
    undefined,
  );
  assert.equal(readRasterEnvelopeIdentity("nope"), undefined);
});

test("配对与 attestation：image 后紧跟引用文本才成对；protection 匹配才出 attestation", () => {
  const pair = framePair();
  const content = [{ type: "text", text: "lead" }, ...pair, { type: "text", text: "tail" }];
  const found = findOfficialCuaFrameContentPair(content);
  assert.equal(found.imageIndex, 1);
  assert.equal(found.imageRefIndex, 2);
  assert.deepEqual(attestOfficialCuaFrameContent(content), {
    kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  });
  // 引用不在 image 之后（顺序颠倒）不成对
  const flipped = [
    { type: "text", text: frameRef() },
    { type: "image", data: "c2hvdA==", mimeType: "image/png" },
  ];
  assert.equal(findOfficialCuaFrameContentPair(flipped), undefined);
  assert.equal(attestOfficialCuaFrameContent(flipped), undefined);
  // protection 与期望不一致不出 attestation
  const mismatched = [
    { type: "image", data: "c2hvdA==", mimeType: "image/png" },
    { type: "text", text: frameRef({ contentProtection: "other" }) },
  ];
  assert.equal(findOfficialCuaFrameContentPair(mismatched), undefined);
  assert.equal(attestOfficialCuaFrameContent(mismatched, "other"), undefined);

  // ref 声称 PNG、相邻栅格却是 JPEG 时不能建立受信坐标对。
  const wrongRaster = [
    { type: "image", data: "c2hvdA==", mimeType: "image/jpeg" },
    { type: "text", text: frameRef() },
  ];
  assert.equal(findOfficialCuaFrameContentPair(wrongRaster), undefined);

  // 模型归一化后的 image block 使用 mediaType/dataUrl，仍应识别同一严格 pair。
  const normalizedPair = [
    { type: "image", dataUrl: "data:image/png;base64,c2hvdA==", mediaType: "image/png" },
    { type: "text", text: frameRef() },
  ];
  assert.ok(findOfficialCuaFrameContentPair(normalizedPair));
});

test("保留路径：非官方帧结果原样返回（同一引用）", async () => {
  const result = {
    content: [...framePair()],
    isError: false,
    _meta: { [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {} },
  };
  assert.equal(await preserveOfficialCuaFrameResult(result, {}), result);
});

test("保留路径：超限栅格经 imageProcessorPort 压缩，引用宽高与 _meta 同步改写", async () => {
  const bigBase64 = "A".repeat(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES + 1);
  const port = {
    // imageProcessorPort 的契约返回原始字节（见 core 归一化层的用法），不是 base64 字符串
    prepareForModel: async (request) => {
      assert.equal(request.maxBase64Bytes, OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES);
      assert.equal(request.maxRawBytes, 150 * 1024);
      assert.equal(request.maxDimension, 2000);
      return {
        data: Buffer.from("small-png"),
        mediaType: "image/png",
        width: 1280,
        height: 720,
      };
    },
  };
  const meta = {
    [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
      contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    },
  };
  const result = {
    content: framePair(bigBase64),
    _meta: meta,
  };
  const preserved = await preserveOfficialCuaFrameResult(result, { imageProcessorPort: port });
  assert.notEqual(preserved, result);
  assert.notEqual(preserved._meta, meta);
  assert.deepEqual(preserved._meta, {
    [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
      contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
      envelopeAlgorithm: "png-raster-envelope-v1/1280x720",
    },
  });
  assert.deepEqual(preserved.content[0], {
    type: "image",
    data: Buffer.from("small-png").toString("base64"),
    mimeType: "image/png",
  });
  const ref = JSON.parse(preserved.content[1].text);
  assert.equal(ref.width, 1280);
  assert.equal(ref.height, 720);
  assert.equal(ref.frameId, "frame-1");
  assert.equal(ref.envelopeAlgorithm, "png-raster-envelope-v1/1280x720");
  assert.ok(isOfficialCuaImageRefText(preserved.content[1].text));
  assert.ok(findOfficialCuaFrameContentPair(preserved.content));
});

test("保留路径：PNG 转 JPEG 时同步 mime 并移除不再适用的 PNG envelope", async () => {
  const bigBase64 = "A".repeat(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES + 1);
  const result = {
    content: framePair(bigBase64, {
      envelopeAlgorithm: "png-raster-envelope-v1/2560x1440",
    }),
    _meta: {
      [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
        contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
        envelopeAlgorithm: "png-raster-envelope-v1/2560x1440",
      },
    },
  };
  const preserved = await preserveOfficialCuaFrameResult(result, {
    imageProcessorPort: {
      prepareForModel: async () => ({
        data: Buffer.from("small-jpeg"),
        mediaType: "image/jpeg",
        width: 800,
        height: 450,
      }),
    },
  });
  const ref = JSON.parse(preserved.content[1].text);
  assert.equal(ref.mimeType, "image/jpeg");
  assert.equal(ref.width, 800);
  assert.equal(ref.height, 450);
  assert.equal(ref.envelopeAlgorithm, undefined);
  assert.equal(preserved._meta[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY].envelopeAlgorithm, undefined);
  assert.ok(isOfficialCuaImageRefText(preserved.content[1].text));
  assert.ok(findOfficialCuaFrameContentPair(preserved.content));
});

test("保留路径：压缩失败或端口缺失时原样保留超限栅格（块不丢弃）", async () => {
  const bigBase64 = "A".repeat(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES + 1);
  const failingPort = {
    prepareForModel: async () => ({ data: Buffer.alloc(0), mediaType: "image/png" }),
  };
  const missingDimensionsPort = {
    prepareForModel: async () => ({ data: Buffer.from("changed"), mediaType: "image/png" }),
  };
  const result = { content: framePair(bigBase64) };
  const viaFailingPort = await preserveOfficialCuaFrameResult(result, {
    imageProcessorPort: failingPort,
  });
  assert.equal(viaFailingPort, result);
  assert.equal(
    await preserveOfficialCuaFrameResult(result, {
      imageProcessorPort: missingDimensionsPort,
    }),
    result,
  );
  const viaMissingPort = await preserveOfficialCuaFrameResult(result, {});
  assert.equal(viaMissingPort, result);
});

test("保留路径：官方帧之后的普通内容不受影响，成对块一起移动", async () => {
  const bigBase64 = "A".repeat(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES + 1);
  const port = {
    prepareForModel: async () => ({
      data: Buffer.from("tiny"),
      mediaType: "image/png",
      width: 10,
      height: 10,
    }),
  };
  const result = {
    content: [
      { type: "text", text: "before" },
      ...framePair(bigBase64),
      { type: "text", text: "after" },
    ],
  };
  const preserved = await preserveOfficialCuaFrameResult(result, { imageProcessorPort: port });
  assert.equal(preserved.content.length, 4);
  assert.equal(preserved.content[0].text, "before");
  assert.equal(preserved.content[3].text, "after");
});
