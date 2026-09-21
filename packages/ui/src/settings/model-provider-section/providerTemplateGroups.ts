import type { ProviderSettingsView } from "@zcode/services";

export interface ProviderTemplateGroup {
  readonly id: string;
  readonly templates: ProviderSettingsView["providerTemplates"];
}

const TEMPLATE_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["zhipu", ["bigmodel-api", "zai-api", "bigmodel-standard-api", "zai-standard-api"]],
  ["kimi", ["moonshot-kimi"]],
  ["minimax", ["minimax"]],
  ["deepseek", ["deepseek"]],
  ["alibaba", ["qwen-alibaba-model-studio-cn", "qwen-alibaba-model-studio-intl"]],
  ["xiaomi", ["xiaomi-mimo"]],
  ["openai", ["openai"]],
  ["anthropic", ["anthropic"]],
  ["xai", ["xai"]],
  ["openrouter", ["openrouter"]],
  [
    "opencode",
    [
      "opencode-go-chat",
      "opencode-go-messages",
      "opencode-go-responses",
      "opencode-zen-responses",
      "opencode-zen-messages",
      "opencode-zen-chat",
    ],
  ],
];

export function groupProviderTemplates(
  templates: ProviderSettingsView["providerTemplates"],
): ProviderTemplateGroup[] {
  const used = new Set<string>();
  const groups = TEMPLATE_GROUPS.map(([id, ids]) => {
    const matched = ids.flatMap((templateId) =>
      templates.filter((template) => template.templateId === templateId),
    );
    for (const template of matched) used.add(template.templateId);
    return { id, templates: matched };
  }).filter((group) => group.templates.length > 0);
  const other = templates.filter((template) => !used.has(template.templateId));
  return [...groups, { id: "other", templates: other }];
}
