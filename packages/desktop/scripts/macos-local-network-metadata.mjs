import { resolve } from "node:path";
import { execCommand } from "../../../scripts/spawn-command.mjs";

export async function verifyMacLocalNetworkUsage({
  electronPlatformName,
  resourcesDir,
  run = execCommand,
}) {
  if (electronPlatformName !== "darwin") return;

  // 原因：仅配置用途说明不能证明 builder 已写入主 app。签名前只读校验实际 plist，
  // 缺失即阻止坏包发行；不修改自签身份或系统权限，不把 SSH 握手失败误报为授权拒绝。
  const { stdout } = await run(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", resolve(resourcesDir, "..", "Info.plist")],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const description = JSON.parse(stdout)?.NSLocalNetworkUsageDescription;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error("macOS package is missing a valid NSLocalNetworkUsageDescription");
  }
}
