// 本机端到端自检：真实 nut-js 驱动在真机上截图 + 指针移动。
// 默认跳过（CI 无桌面、无人值守机器不该动指针）；显式 ZCODE_CUA_E2E=1 才执行：
//   ZCODE_CUA_E2E=1 pnpm --dir packages/zcode-cua e2e:local
// 本脚本显式组装包内驱动 seam，只验证驱动与兼容 runtime；产品公开入口始终走 Helper，
// 不会因为这里的测试装配而获得本地驱动回退。
import assert from "node:assert/strict";
import { createNutJsDriver, resolveNutKeyName } from "./cua-driver.js";
import { createBrokerPermissionGate, createComputerUseRuntimeWithDriver } from "./runtime.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

if (process.env.ZCODE_CUA_E2E !== "1") {
  console.log("e2e-local: skipped (set ZCODE_CUA_E2E=1 to run on a real desktop)");
  process.exit(0);
}

const gate = createBrokerPermissionGate({
  brokerSocketPath: "e2e-local-self-check",
});
const runtime = createComputerUseRuntimeWithDriver(createNutJsDriver(), gate, {
  isKnownKeyName: (name) => resolveNutKeyName(name) !== undefined,
});

try {
  // 1) 真实截图：PNG 魔数、非零尺寸、官方帧对与 integrity meta 齐备
  const shot = await runtime.execute({
    toolName: "screenshot",
    context: { sessionId: "e2e", runtimeScope: "main", workspaceKey: "e2e" },
  });
  assert.ok(!shot.isError, `screenshot failed: ${JSON.stringify(shot.content)}`);
  const image = shot.content[0];
  const png = Buffer.from(image.data, "base64");
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    assert.equal(png[i], PNG_MAGIC[i], "screenshot is not a PNG");
  }
  const ref = JSON.parse(shot.content[1].text);
  assert.equal(ref.type, "zcode_cua_frame_ref");
  assert.ok(shot._meta["zcode.cua/official-frame-integrity-v1"], "integrity meta missing");
  assert.ok(ref.width > 0 && ref.height > 0, "raster dimensions missing");
  console.log(
    `e2e-local: screenshot ok (${ref.width}x${ref.height}, ${(png.byteLength / 1024).toFixed(0)} KiB)`,
  );

  // 2) 指针动作：按截图光栅坐标系移动 1px 再回原点（无点击、无键入、无滚动）
  const cx = Math.floor(ref.width / 2);
  const cy = Math.floor(ref.height / 2);
  const move = async (x, y) => {
    const result = await runtime.execute({
      toolName: "move",
      arguments: { x, y },
      context: { sessionId: "e2e", runtimeScope: "main", workspaceKey: "e2e" },
    });
    assert.ok(!result.isError, `move failed: ${JSON.stringify(result.content)}`);
  };
  await move(cx, cy);
  await move(cx + 1, cy);
  await move(cx, cy);
  console.log("e2e-local: pointer move ok (center -> +1px -> center)");

  // 3) 会话收尾与释放
  await runtime.closeSession({ sessionId: "e2e", runtimeScope: "main", workspaceKey: "e2e" });
  console.log("e2e-local: closeSession ok");
  console.log("e2e-local: PASS");
} finally {
  await runtime.dispose();
}
