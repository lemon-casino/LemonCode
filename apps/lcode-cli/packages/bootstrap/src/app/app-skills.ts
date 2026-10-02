import { createNodeSkillAdapter } from "@lcode/adapters/skills";
import type { LCodeAppOptions } from "./types.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import type { ConfigResult } from "@lcode/adapters/config";
import type { PluginLoadOutcome } from "@lcode/contracts";
import type { AgentRuntimeConfig } from "@lcode/core";

export function createAppSkillPort(input: {
  options: LCodeAppOptions;
  configResult: ConfigResult;
  pluginOutcome: PluginLoadOutcome;
  runtimeConfig: AgentRuntimeConfig;
}) {
  const { options, configResult, pluginOutcome, runtimeConfig } = input;
  const skillPort =
    configResult.config.features.skill && configResult.config.skills.enabled
      ? (options.skillPort ??
        createNodeSkillAdapter({
          extraRoots: configResult.config.skills.roots,
          extraResolvedRoots: pluginOutcome.skillRoots,
          disabledPaths: [
            ...collectDisabledPaths(configResult.config.skillOverrides),
            ...(runtimeConfig.dynamicWorkflowEnabled === false
              ? collectDynamicWorkflowDisabledSkillPaths(pluginOutcome.skillRoots)
              : []),
          ],
        }))
      : undefined;
  return skillPort;
}
