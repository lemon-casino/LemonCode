import type { AppSettings, ProxyProfile, RemoteTarget } from "@lcode/shared";
import { isNetworkProxyUrl } from "@lcode/shared";
import { connectNetworkProxySocket } from "@lcode/provider-node/network";
import type { RemoteBackendOptions } from "@lcode/server/remote";

type SshProxySettings = Pick<AppSettings, "httpProxy" | "httpProxyCaCertPath"> & {
  proxyProfiles?: readonly ProxyProfile[];
};

/** 设置仍由本地 Host 唯一持有；SSH 目标及历史只携带模式和代理 ID。 */
export async function resolveSshSettingsProxy(
  target: RemoteTarget,
  readSettings: () => Promise<SshProxySettings>,
  connectSocket = connectNetworkProxySocket,
): Promise<RemoteBackendOptions["sshProxy"]> {
  if (target.kind !== "ssh" || !target.useProxy) return undefined;
  const settings = await readSettings();
  // 之前只读取默认代理，导致选择代理库条目没有实际效果。指定 ID 必须精确解析，删除后不能换用其他代理。
  const profile =
    target.proxyProfileId !== undefined
      ? settings.proxyProfiles?.find((item) => item.id === target.proxyProfileId)
      : undefined;
  if (target.proxyProfileId !== undefined && !profile)
    throw new Error("所选代理已不存在，请重新选择设置中的代理");
  const proxyUrl = (profile ? profile.httpProxy : settings.httpProxy)?.trim();
  if (!proxyUrl || !isNetworkProxyUrl(proxyUrl))
    throw new Error("请在设置中配置有效的所选代理（HTTP、HTTPS 或 SOCKS5）");
  return (destination, signal) =>
    connectSocket({
      ...destination,
      proxyUrl,
      caCertPath: profile ? profile.caCertPath : settings.httpProxyCaCertPath,
      signal,
    });
}
