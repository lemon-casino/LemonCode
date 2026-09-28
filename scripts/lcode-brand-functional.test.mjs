// 品牌迁移功能回归：RPC 序列化 marker 往返（一次性补强测试）
// 运行：npx tsx --test scripts/lcode-brand-functional.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

test("RPC 序列化：Uint8Array 嵌套经 __lcode_rpc_nested_uint8array_v1 marker 往返无损", async () => {
  const { BufferWriter, BufferReader, serialize, deserialize } = await import(
    "../packages/rpc/src/serialization.js"
  );
  const payload = {
    kind: "round-trip",
    nested: new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]),
    list: [1, "two", new Uint8Array([9, 8, 7])],
  };
  const writer = new BufferWriter();
  serialize(writer, payload);
  const bytes = writer.buffer.buffer;
  // marker 是线上契约：序列化结果必须真实包含它（改名后两端同批，marker 必须在字节流里）
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  assert.ok(text.includes("__lcode_rpc_nested_uint8array_v1"), "序列化字节流缺少嵌套 marker");
  const restored = deserialize(new BufferReader(writer.buffer));
  assert.equal(restored.kind, "round-trip");
  assert.ok(restored.nested instanceof Uint8Array);
  assert.deepEqual([...restored.nested], [...payload.nested]);
  assert.ok(restored.list[2] instanceof Uint8Array);
  assert.deepEqual([...restored.list[2]], [9, 8, 7]);
});

// 流控帧（__lcodeRpcControl）由 packages/desktop/src/main/desktopRemoteControlFramePump.test.ts 覆盖；
// 判定函数为模块私有，此处不重复断言。
