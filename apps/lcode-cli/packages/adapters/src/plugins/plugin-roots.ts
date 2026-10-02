import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CustomCommandRoot,
  HookEventName,
  HookMatcherConfig,
  HookPluginContext,
  PluginDiagnostic,
  PluginHookDetail,
  SkillRoot,
} from "@lcode/contracts";
import { directoryExists, isMissingPath, parsePathList, resolveInside } from "./helpers.js";
import { scanSkillFilesUnderRootSync } from "../skills/scan.js";
import { resolvePluginMcpServers } from "./mcp.js";
import { createHookPluginContext } from "./plugin-hooks.js";
import { materializeCommandMetadataRoot } from "./plugin-commands.js";
import type { LoadedPlugin, PluginComponents } from "./types.js";

export function resolveEnabledComponents(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  hookDetails: PluginHookDetail[];
  hookEvents: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  loaded: LoadedPlugin;
  mcpServerDefinitions: Record<string, unknown>;
  options: Record<string, string | number | boolean>;
  priority: number;
  workingDirectory: string;
}): PluginComponents {
  mkdirSync(input.dataPath, { recursive: true });

  const skillRoots = resolveSkillRoots(input, input.priority);
  return {
    commandRoots: resolveCommandRoots(input, input.priority + 1),
    hooks: input.hookEvents,
    hookDetails: input.hookDetails,
    mcpServers: resolvePluginMcpServers({
      ...input,
      definitions: input.mcpServerDefinitions,
    }),
    // 插件页要展示真实技能数量。之前只统计 skills root 数，
    // document-skills 这种一个 root 下有多个 SKILL.md 的插件会被显示成 1。
    skillCount: countSkillFiles(skillRoots),
    skillRoots,
  };
}

export function resolveSkillRoots(
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): SkillRoot[] {
  warnEmptyDeclaredSkillRoots(input);
  return resolveComponentRoots("skills", input, priority);
}

/**
 * manifest 显式声明的 skills 路径没有可用技能时发出诊断，避免路径配置错误静默失败。
 * 声明集合独立于 roots 列表计算，默认 skills/ 目录为空时不误报；路径缺失、目录为空和
 * 符号链接越界分别保留可操作的诊断信息，权限错误交给实际扫描链路报告。
 */
export function warnEmptyDeclaredSkillRoots(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): void {
  const declared = parsePathList(input.loaded.manifest.skills);
  if (declared.length === 0) return;
  const seenPaths = new Set<string>();
  for (const rawPath of declared) {
    const resolved = resolveInside(input.loaded.rootPath, rawPath);
    if (!resolved || seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    // 路径缺失判定只认 ENOENT/ENOTDIR（statSync 精确分类），EACCES 等权限
    // 错误不得误报成「不存在」——此时没有证据下结论，跳过告警，由 skill adapter
    // 扫描同一目录时发 skill_scan_failed。
    // message 按原因区分：「路径不存在」是 manifest 配错，「存在但没有技能」
    // 是内容问题，「symlink 逃逸出插件根」是安全拒绝，三者修复方式不同；
    // code 保持单一，UI 无需感知分类。
    if (isMissingPath(resolved)) {
      input.diagnostics.push({
        code: "plugin_skill_root_empty",
        message: `Plugin skills path does not exist: ${rawPath}`,
        path: resolved,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    // 信任边界：声明路径是插件内容，扫描不跟随符号链接（目录级/文件级逃逸
    // 一并拒绝，含 Windows junction）。链接根/链接 SKILL.md 扫描为空后落入下方
    // 「没有任何技能」告警，不误报「不存在」（词法路径本身存在）。
    let skillFiles: string[];
    try {
      skillFiles = scanSkillFilesUnderRootSync(resolved, { followSymbolicLinks: false });
    } catch {
      continue;
    }
    if (skillFiles.length > 0) continue;
    input.diagnostics.push({
      code: "plugin_skill_root_empty",
      message: `Plugin skills path does not contain any skills: ${rawPath}`,
      path: resolved,
      pluginId: input.loaded.id,
      severity: "warning",
    });
  }
}

export function resolveCommandRoots(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): CustomCommandRoot[] {
  const roots = resolveComponentRoots<CustomCommandRoot>(
    "commands",
    input,
    priority,
    createHookPluginContext(input.loaded, input.dataPath),
  );
  const generatedRoot = materializeCommandMetadataRoot(input, priority + 1);
  if (generatedRoot) roots.push(generatedRoot);
  return roots;
}

export function countSkillFiles(skillRoots: SkillRoot[]): number {
  // 技能识别规则收敛到共享 scan helper（根自身含
  // SKILL.md 时根自身是一个技能）；同时声明根与
  // 默认 skills/ 根会命中同一个 SKILL.md，必须按文件路径去重，否则计数翻倍。
  // 顺带修正漂移：只认 isDirectory() 会漏掉 symlink 技能子目录，统一 helper 后一并计入。
  // helper 只吞 ENOENT；权限错误（EACCES 等）会抛出，这里按原语义把该根计 0，
  // 真正的 skill_scan_failed 诊断由 skill adapter 在运行时扫描同一目录时发出。
  // 信任边界：这里只消费 plugin roots（resolveSkillRoots 产物），不跟随符号链接。
  const seenFiles = new Set<string>();
  for (const skillRoot of skillRoots) {
    try {
      for (const file of scanSkillFilesUnderRootSync(skillRoot.path, {
        followSymbolicLinks: skillRoot.source !== "plugin",
      })) {
        seenFiles.add(file);
      }
    } catch {
      // 概览计数降级为 0；扫描诊断由 skill adapter 负责。
    }
  }
  return seenFiles.size;
}

export function resolveComponentRoots<T extends CustomCommandRoot | SkillRoot>(
  key: "commands" | "skills",
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
  plugin?: HookPluginContext,
): T[] {
  const paths = parsePathList(input.loaded.manifest[key]);
  const defaultPath = join(input.loaded.rootPath, key);
  if (directoryExists(defaultPath)) {
    paths.unshift(key);
  }
  const roots: T[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of paths) {
    const path = resolveInside(input.loaded.rootPath, rawPath);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin ${key} path escapes plugin root: ${rawPath}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    roots.push({
      path,
      ...(plugin ? { plugin } : {}),
      ...(key === "skills" ? { pluginId: input.loaded.id } : {}),
      priority,
      scope: input.loaded.source === "official" ? "system" : "user",
      source: "plugin",
    } as T);
  }
  return roots;
}
