import { extname, resolve } from "node:path";
import { VideoInspectInputSchema } from "@lcode/contracts";
import { wildcardToRegExp } from "../../permission/rule-matching.js";
import type { ToolPermissionRulePolicy, ToolRuntimePermissionCapabilityContext } from "../types.js";

export function resolveVideoPermissionRulePolicy(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolPermissionRulePolicy | undefined {
  const parsed = VideoInspectInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.action !== "transcript") return undefined;
  const path = parsed.data.file_path;
  const stem = path.slice(0, path.length - extname(path).length);
  const paths = [path, stem + ".srt", stem + ".vtt"];
  const normalize = (value: string) => value.replace(/\\/gu, "/");
  const subjectGroups = paths.map((value) => [
    normalize(value),
    ...(context?.workingDirectory ? [normalize(resolve(context.workingDirectory, value))] : []),
  ]);
  return {
    evaluateRules(behavior, rules) {
      const matches = (subjects: string[]) =>
        rules.some(
          (rule) =>
            !rule.ruleContent ||
            subjects.some((subject) =>
              [
                normalize(rule.ruleContent!),
                ...(context?.workingDirectory
                  ? [normalize(resolve(context.workingDirectory, rule.ruleContent!))]
                  : []),
              ].some((pattern) => wildcardToRegExp(pattern).test(subject)),
            ),
        );
      // 字幕由 adapter 发现；权限检查保守覆盖两个候选，防止只检查视频后旁路读取受限字幕。
      return behavior === "allow" ? subjectGroups.every(matches) : subjectGroups.some(matches);
    },
    suggestedPermissionUpdates: [
      {
        type: "addRules",
        behavior: "allow",
        rules: paths.map((ruleContent) => ({ toolName: "VideoInspect", ruleContent })),
      },
    ],
  };
}
