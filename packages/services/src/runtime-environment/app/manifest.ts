import { createHash } from "node:crypto";
import type { FrozenManifest } from "@lcode/shared";
import { serializeDeclarations, type ProjectDeclarations } from "../domain/declarations.js";

export function declarationDigest(declarations: ProjectDeclarations): string {
  return createHash("sha256").update(serializeDeclarations(declarations)).digest("hex");
}
export function manifestDigest(manifest: FrozenManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        backendVersion: manifest.backendVersion,
        os: manifest.os,
        arch: manifest.arch,
        tools: [...manifest.tools].sort((a, b) => a.key.localeCompare(b.key)),
        declarationDigest: manifest.declarationDigest,
        installStrategy: manifest.installStrategy,
        resources: manifest.resources ?? null,
      }),
    )
    .digest("hex");
}
export function hostPlatform(): FrozenManifest["os"] {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}
export function safeEnvironmentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Authorization 的方案和凭据是一个值；只遮掉 Bearer 会把真正 token 留在错误文本中。
  return message
    .replace(/https?:\/\/[^\s<>"']+/giu, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(
      /((?:proxy-)?authorization\s*[=:]\s*)(?:bearer|basic|token)\s+[^\s,;"']+/giu,
      "$1[redacted]",
    )
    .replace(
      /((?:token|password|authorization|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      "$1[redacted]",
    )
    .slice(-8192);
}
