export interface RemoteAssetNetworkPort {
  fetch: typeof globalThis.fetch;
  readonly source?: "bundled";
}

export function remoteAssetReadLog(
  network: RemoteAssetNetworkPort | undefined,
  url: string,
): string {
  return network?.source === "bundled"
    ? `[remote-assets] reading bundled resource ${decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "")}`
    : `[remote-assets] downloading ${url}`;
}

export function resolveRemoteAssetFetch(
  network: RemoteAssetNetworkPort | undefined,
): typeof globalThis.fetch {
  // Desktop Host 的远程资源下载曾直接使用 global fetch，绕过设置页代理。
  // standalone server 没有 Desktop 设置权威，保留未注入时直连的既有合同。
  return network?.fetch ?? globalThis.fetch.bind(globalThis);
}
