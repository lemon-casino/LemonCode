import semver from "semver";

export type PluginUpdateStatus = "none" | "update-available" | "version-changed";

/**
 * Compare an installed plugin version against the latest manifest version.
 * - semver.gt(latest, installed) -> "update-available"
 * - parseable + not greater (equal or older) -> "none"
 * - unparseable but differing -> "version-changed" (we can't prove it's newer)
 * - unparseable + equal, or either missing -> "none"
 */
export function comparePluginVersions(input: {
  installed: string | undefined;
  latest: string | undefined;
}): PluginUpdateStatus {
  const { installed, latest } = input;
  if (!installed || !latest) return "none";
  const installedValid = semver.valid(semver.coerce(installed) ?? installed);
  const latestValid = semver.valid(semver.coerce(latest) ?? latest);
  if (installedValid && latestValid) {
    return semver.gt(latestValid, installedValid) ? "update-available" : "none";
  }
  return installed === latest ? "none" : "version-changed";
}

/**
 * 按最新目录条目实际提供的比较轴判断更新状态：优先比较可解析的 version，缺失时比较
 * source identity pin；两者都缺失时保持 none，避免把无法证明的新旧关系误报为更新。
 */
export function comparePluginUpdate(input: {
  installedVersion: string | undefined;
  installedSha: string | undefined;
  latestVersion: string | undefined;
  latestSha: string | undefined;
}): PluginUpdateStatus {
  const { installedVersion, installedSha, latestVersion, latestSha } = input;
  if (latestVersion) {
    return comparePluginVersions({ installed: installedVersion, latest: latestVersion });
  }
  if (latestSha) {
    if (!installedSha) return "version-changed";
    return installedSha === latestSha ? "none" : "update-available";
  }
  return "none";
}
