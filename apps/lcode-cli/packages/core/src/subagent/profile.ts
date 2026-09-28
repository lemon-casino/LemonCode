import { basename } from "node:path";
import { GENERAL_PURPOSE_AGENT_TYPE, buildGeneralPurposeSystemPrompt } from "./general-purpose.js";
import { EXPLORE_AGENT_TYPE } from "./explore.js";
import { formatExploreAllowedToolsForAgentDescription } from "./explore-tools.js";
import { parseAgentFrontmatter, splitMarkdownFrontmatter } from "./profile-frontmatter.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import type { ModelSelection } from "@lcode/shared";
import { resolveProfileModelSelection } from "./profile-model-selection.js";

export const DEFAULT_SUBAGENT_TYPE = GENERAL_PURPOSE_AGENT_TYPE;

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<typeof DEFAULT_SUBAGENT_TYPE | typeof EXPLORE_AGENT_TYPE, ModelSelection>
>;

export type AgentPermissionMode = "auto" | "plan";

export type AgentProfileSource = "built-in" | "project" | "user";
export type AgentMemoryScope = "user" | "project" | "local";

export interface AgentProfile {
  background?: boolean;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
  description: string;
  disallowedTools?: readonly string[];
  injectAgentsMd?: boolean;
  maxTurns?: number;
  mcpServers?: readonly string[];
  memory?: AgentMemoryScope;
  modelSelection?: ModelSelection;
  name: string;
  path?: string;
  permissionMode?: AgentPermissionMode;
  skills?: readonly string[];
  source: AgentProfileSource;
  systemPrompt: string;
  tools?: readonly string[];
}

export interface AgentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentProfileLoadResult {
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

const VALID_COLORS = new Set<NonNullable<AgentProfile["color"]>>([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

const VALID_PERMISSION_MODES = new Set<AgentPermissionMode>(["auto", "plan"]);

const VALID_MEMORY_SCOPES = new Set<AgentMemoryScope>(["user", "project", "local"]);

export function createBuiltInExploreAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
    color: "cyan",
    injectAgentsMd: false,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: "",
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
  };
}

export function isBuiltInExploreAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  // 用户/项目 profile 可以同名覆盖内置 Explore，不能只按名称套用内置行为。
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === "built-in";
}

export function normalizeAgentProfiles(
  profiles: readonly AgentProfile[],
  options: {
    builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  } = {},
): AgentProfile[] {
  const overrides = options.builtInModelSelectionOverrides ?? {};
  const active = new Map<string, AgentProfile>();
  active.set(
    DEFAULT_SUBAGENT_TYPE,
    createBuiltInGeneralPurposeAgentProfile({
      modelSelection: overrides[DEFAULT_SUBAGENT_TYPE],
    }),
  );
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreAgentProfile({
      modelSelection: overrides[EXPLORE_AGENT_TYPE],
    }),
  );
  for (const profile of profiles) {
    active.set(profile.name, profile);
  }
  return Array.from(active.values());
}

export function createBuiltInGeneralPurposeAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: DEFAULT_SUBAGENT_TYPE,
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
    // 内置子智能体使用显式身份色，避免 UI 按名称 hash 后把 general-purpose 显示为红色。
    color: "blue",
    injectAgentsMd: true,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: buildGeneralPurposeSystemPrompt(),
    tools: ["*"],
  };
}

export function formatAgentProfilesForPrompt(
  profiles: readonly AgentProfile[],
  options: { embeddedSearchEnabled?: boolean } = {},
): string | null {
  const active = normalizeAgentProfiles(profiles);
  if (active.length === 0) return null;

  return [
    "Available agent types and the tools they have access to:",
    ...active.map((profile) => {
      const tools = isBuiltInExploreAgentProfile(profile)
        ? formatExploreAllowedToolsForAgentDescription(options)
        : profile.tools
          ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
          : undefined;
      const toolText = typeof tools === "string" ? tools : tools?.join(", ");
      const suffix = toolText ? ` (Tools: ${toolText})` : "";
      return `- ${profile.name}: ${profile.description}${suffix}`;
    }),
  ].join("\n");
}

export function parseAgentProfileFromMarkdown(input: {
  content: string;
  path?: string;
  source: AgentProfileSource;
}): { diagnostic?: AgentProfileParseDiagnostic; profile?: AgentProfile } {
  const parsed = splitMarkdownFrontmatter(input.content);
  if (!parsed.frontmatter) {
    return {
      diagnostic: {
        code: "agent_missing_frontmatter",
        message: `Agent Markdown must include frontmatter: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  const { mcpServers, values: frontmatter } = parseAgentFrontmatter(parsed.frontmatter);
  const name = scalarString(frontmatter.name);
  const description = scalarString(frontmatter.description)?.replace(/\\n/gu, "\n");
  if (!name) {
    return missingRequiredDiagnostic("name", input.path);
  }
  if (!description) {
    return missingRequiredDiagnostic("description", input.path);
  }

  const modelSelection = resolveProfileModelSelection(frontmatter);
  const color = normalizeColor(scalarString(frontmatter.color));
  const parsedPermissionMode = normalizePermissionMode(scalarString(frontmatter.permissionMode));
  // 项目级 subagent markdown 属于仓库输入，不能通过 frontmatter 把
  // child runtime 提升到 bypass/yolo；权限模式只接受用户级或受信插件配置。
  const permissionMode = input.source === "project" ? undefined : parsedPermissionMode;
  const maxTurns = normalizePositiveInteger(frontmatter.maxTurns);
  const memory = parseAgentMemoryScope(frontmatter.memory);
  const memoryDiagnostic =
    frontmatter.memory !== undefined && memory === undefined
      ? {
          code: "agent_invalid_memory_scope",
          message: `Agent frontmatter memory must be user, project, or local: ${input.path ?? "<inline>"}`,
          path: input.path,
        }
      : undefined;
  if (mcpServers === null) {
    return {
      diagnostic: {
        code: "agent_invalid_mcp_servers",
        message: `Agent frontmatter mcpServers must be a list of parent server names: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  return {
    ...(memoryDiagnostic ? { diagnostic: memoryDiagnostic } : {}),
    profile: {
      name,
      description,
      source: input.source,
      systemPrompt: parsed.body.trim(),
      ...(input.path ? { path: input.path } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(color ? { color } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(memory ? { memory } : {}),
      ...optionalList("tools", frontmatter.tools),
      ...optionalList("disallowedTools", frontmatter.disallowedTools),
      ...optionalList("skills", frontmatter.skills),
      ...optionalBoolean("background", frontmatter.background),
      ...optionalBoolean("injectAgentsMd", frontmatter.injectAgentsMd),
      ...(mcpServers === undefined ? {} : { mcpServers }),
    },
  };
}

function parseAgentMemoryScope(value: unknown): AgentMemoryScope | undefined {
  return typeof value === "string" && VALID_MEMORY_SCOPES.has(value as AgentMemoryScope)
    ? (value as AgentMemoryScope)
    : undefined;
}

function missingRequiredDiagnostic(
  field: string,
  path: string | undefined,
): { diagnostic: AgentProfileParseDiagnostic } {
  return {
    diagnostic: {
      code: "agent_missing_required_frontmatter",
      message: `Agent frontmatter must include ${field}: ${path ?? "<inline>"}`,
      path,
    },
  };
}

function parseToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return normalizeToolNames(normalizeStringList(value));
  }
  if (typeof value !== "string") return undefined;
  const result: string[] = [];
  let current = "";
  let parenDepth = 0;
  for (const char of value) {
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (parenDepth === 0 && (char === "," || /\s/u.test(char))) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return normalizeToolNames(result);
}

function optionalList(
  key: "disallowedTools" | "skills" | "tools",
  value: unknown,
): Partial<AgentProfile> {
  const list = key === "skills" ? normalizeStringList(value) : parseToolList(value);
  if (list && list.length > 0) return { [key]: list };
  if (key === "tools" && Array.isArray(value)) {
    return { tools: [] };
  }
  return {};
}

function optionalBoolean(
  key: "background" | "injectAgentsMd",
  value: unknown,
): Partial<AgentProfile> {
  if (typeof value === "boolean") return { [key]: value };
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return { [key]: true };
    if (value.toLowerCase() === "false") return { [key]: false };
  }
  return {};
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return list.length > 0 ? list : undefined;
  }
  if (typeof value !== "string") return undefined;
  const list = value
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeColor(value: string | undefined): AgentProfile["color"] | undefined {
  if (!value) return undefined;
  return VALID_COLORS.has(value as NonNullable<AgentProfile["color"]>)
    ? (value as NonNullable<AgentProfile["color"]>)
    : undefined;
}

function normalizePermissionMode(value: string | undefined): AgentPermissionMode | undefined {
  if (!value) return undefined;
  return VALID_PERMISSION_MODES.has(value as AgentPermissionMode)
    ? (value as AgentPermissionMode)
    : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function agentProfileDisplayName(profile: AgentProfile): string {
  return profile.path ? `${profile.name} (${basename(profile.path)})` : profile.name;
}

function normalizeToolNames(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const names = values.map(toolNameFromSpec).filter((item) => item.length > 0);
  return names.length > 0 ? names : undefined;
}

function toolNameFromSpec(value: string): string {
  const trimmed = value.trim();
  const parenIndex = trimmed.indexOf("(");
  if (parenIndex < 0) return trimmed;
  return trimmed.slice(0, parenIndex).trim();
}
