import type { EnvInfo, Model } from "@lcode/contracts";
import { isEnvInfoGitRepository } from "../context/sections/env-info.js";

export interface SubagentEnvironmentContextOptions {
  agentPrompt: string;
  envInfo: EnvInfo;
  model?: Model;
}

export function buildSubagentCommonNotes(): string {
  return [
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    "- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.",
  ].join("\n");
}

export function buildSubagentEnvironmentContext(
  options: SubagentEnvironmentContextOptions,
): string {
  const { envInfo, model } = options;
  const modelLine = model
    ? [`You are powered by the model named ${model.providerId}/${model.modelId}.`]
    : [];

  return [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${envInfo.cwd}`,
    `Is directory a git repo: ${isEnvInfoGitRepository(envInfo) ? "Yes" : "No"}`,
    `Platform: ${envInfo.platform}`,
    `Shell: ${envInfo.shell}`,
    `OS Version: ${envInfo.osVersion}`,
    "</env>",
    ...modelLine,
  ].join("\n");
}
