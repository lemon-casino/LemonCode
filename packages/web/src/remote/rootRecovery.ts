import { loadStoredPairingCredential } from "./pairingCredentialStore.js";
import { parsePairingDeepLink } from "./pairingDeepLink.js";
import type { PairingFailureKey } from "./pairingFrames.js";

type EntryLocation = Pick<Location, "pathname" | "search" | "hash">;

/** 根入口只路由已有授权，鉴权与恢复仍由配对页负责。 */
export function getRootRecoveryTarget(
  location: Pick<Location, "pathname" | "search">,
): string | null {
  if (location.pathname !== "/" || new URLSearchParams(location.search).get("view") === "site")
    return null;
  const stored = loadStoredPairingCredential();
  if (!stored) return null;
  const path = `/p/${stored.roomId}`;
  if (parsePairingDeepLink(path, "")?.roomId !== stored.roomId) return null;
  return `${path}?entry=root`;
}

export function isRootRecoveryEntry(location: EntryLocation): boolean {
  const route = parsePairingDeepLink(location.pathname, location.hash);
  // 显式带 capability 的新链接继续原授权流程，不被入口标记改变。
  return (
    new URLSearchParams(location.search).get("entry") === "root" &&
    route?.roomId != null &&
    route.capability === null
  );
}

export function finishRootRecovery(): void {
  if (!isRootRecoveryEntry(window.location)) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("entry");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function returnRootRecoveryToWebsite(
  key: PairingFailureKey,
  entryHref: string,
  deviceCredential?: string,
): boolean {
  if (window.location.href !== entryHref || !isRootRecoveryEntry(window.location)) return false;
  const current = loadStoredPairingCredential();
  // 旧连接的迟到结果不能让新授权或新导航跳回官网；失效清理仍归原凭据 owner。
  if (current && current.deviceCredential !== deviceCredential) return false;
  const state =
    key === "auth" || key === "revoked" || key === "invalid-link" ? "unpaired" : "unavailable";
  window.location.replace(`/?view=site&remote=${state}`);
  return true;
}
