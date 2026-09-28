import { relative, isAbsolute } from "node:path";
import {
  LCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME as LCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
  LCODE_CUA_OFFICIAL_PLUGIN_ID,
} from "@lcode/shared";
import type { McpToolDescriptor, PluginReferenceCatalog, SkillMetadata } from "@lcode/contracts";
import { toMcpToolName, toModelVisibleMcpNamePart } from "../mcp/name.js";

export const SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE = "SUBAGENT_COMPUTER_USE_UNAVAILABLE" as const;
export const SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE =
  "Computer Use is not available in subagent" as const;

const OFFICIAL_CUA_CANONICAL_PREFIX = "mcp__computer-use__";
const OFFICIAL_CUA_ALIAS_PREFIX = "mcp__computer_use__";
const OFFICIAL_CUA_SERVER_PARTS = new Set([
  "computer-use",
  "computer_use",
  toModelVisibleMcpNamePart(LCODE_CUA_OFFICIAL_MCP_SERVER_NAME),
]);

export interface OfficialCuaPolicy {
  readonly serverNames: ReadonlySet<string>;
  isOfficialToolRequest(name: string): boolean;
  isOfficialServerSelector(name: string): boolean;
  isOfficialSkillRequest(name: string): boolean;
  isOfficialSkill(metadata: SkillMetadata): boolean;
}

export function createOfficialCuaPolicy(
  officialServerNames: ReadonlySet<string>,
  descriptors: readonly McpToolDescriptor[],
  catalog: PluginReferenceCatalog | undefined,
): OfficialCuaPolicy {
  const toolNames = new Set<string>();
  let officialDescriptorCount = 0;
  for (const descriptor of descriptors) {
    if (!officialServerNames.has(descriptor.serverName)) continue;
    officialDescriptorCount += 1;
    toolNames.add(toMcpToolName(descriptor));
    if (descriptor.serverName === LCODE_CUA_OFFICIAL_MCP_SERVER_NAME) {
      const suffix = toModelVisibleMcpNamePart(descriptor.toolName);
      toolNames.add(`${OFFICIAL_CUA_CANONICAL_PREFIX}${suffix}`);
      toolNames.add(`${OFFICIAL_CUA_ALIAS_PREFIX}${suffix}`);
    }
  }

  const officialToolPrefixes = new Set<string>();
  for (const serverName of officialServerNames) {
    officialToolPrefixes.add(`mcp__${toModelVisibleMcpNamePart(serverName)}__`);
  }
  if (officialServerNames.has(LCODE_CUA_OFFICIAL_MCP_SERVER_NAME)) {
    officialToolPrefixes.add(OFFICIAL_CUA_CANONICAL_PREFIX);
    officialToolPrefixes.add(OFFICIAL_CUA_ALIAS_PREFIX);
  }

  const officialServerSelectorParts = new Set<string>();
  for (const serverName of officialServerNames) {
    if (serverName === LCODE_CUA_OFFICIAL_MCP_SERVER_NAME) {
      for (const part of OFFICIAL_CUA_SERVER_PARTS) officialServerSelectorParts.add(part);
      continue;
    }
    officialServerSelectorParts.add(toModelVisibleMcpNamePart(serverName));
  }

  const officialPlugin = catalog?.plugins.find(
    (plugin) => plugin.pluginId === LCODE_CUA_OFFICIAL_PLUGIN_ID,
  );
  const skillQualifiedNames = new Set(officialPlugin?.skillQualifiedNames ?? []);
  const skillBareNames = new Set(
    [...skillQualifiedNames]
      .map((name) => name.slice(name.indexOf(":") + 1))
      .filter((name) => name.length > 0),
  );
  const officialRootPath = officialPlugin?.rootPath;
  const officialPluginName = officialPlugin?.name;

  return {
    serverNames: new Set(officialServerNames),
    isOfficialToolRequest(name) {
      const normalized = name.trim();
      if (toolNames.has(normalized)) return true;
      // Parent MCP 尚无启动快照时，只能依赖已认证 server 的 namespace；一旦收到
      // descriptor，就收窄为精确工具集合，避免第三方同名工具被误判成官方 CUA。
      if (officialDescriptorCount > 0 || officialToolPrefixes.size === 0) return false;
      return [...officialToolPrefixes].some(
        (prefix) => normalized.startsWith(prefix) && normalized.length > prefix.length,
      );
    },
    isOfficialServerSelector(name) {
      const normalized = name.trim();
      if (officialServerNames.size === 0) return false;
      if (!normalized.startsWith("mcp__") || !normalized.endsWith("__*")) return false;
      const serverPart = normalized.slice("mcp__".length, -"__*".length);
      return officialServerSelectorParts.has(serverPart);
    },
    isOfficialSkillRequest(name) {
      const normalized = name.trim();
      // Bare names are resolved against live Skill metadata below. Treating a bare
      // name as official here would reject a third-party Skill with the same name.
      return skillQualifiedNames.has(normalized);
    },
    isOfficialSkill(metadata) {
      if (metadata.source !== "plugin") return false;
      if (!officialPluginName || !officialRootPath) return false;
      if (metadata.pluginName !== officialPluginName) return false;
      if (!isPathWithin(officialRootPath, metadata.rootPath)) return false;
      return metadata.qualifiedName !== undefined
        ? skillQualifiedNames.has(metadata.qualifiedName)
        : skillBareNames.has(metadata.name);
    },
  };
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
