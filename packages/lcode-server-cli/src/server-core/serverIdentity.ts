import { validateServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

/**
 * 读取安装级 Server identity。真实 Supervisor 启动必须提供 server root；未提供时
 * 保持 HTTP 工厂的嵌入/单测兼容，由调用方决定是否使用 hostname fallback。
 */
export async function resolveCoreServerId(
  serverRoot = process.env.LCODE_SERVER_ROOT?.trim(),
): Promise<string | undefined> {
  if (!serverRoot) return undefined;
  const ownership = await validateServerInstallOwnership(resolveServerLayout(serverRoot));
  return ownership.installationId;
}
