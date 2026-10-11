const local = {
  "commandcode-plan": { index: 1, source: "Command Code CLI", fallback: true },
  cursor: { index: 1, source: "cursor-agent" },
  devin: { index: 1, source: "Devin CLI", fallback: true },
  grok: { index: 1, source: "Grok Build" },
  kiro: { index: 1, source: "Kiro CLI or IDE", writeback: true },
  workbuddy: { index: 1, source: "WorkBuddy desktop" },
  "workbuddy-ai": { index: 1, source: "WorkBuddy AI desktop" },
  bigmodel: { index: 2, source: "ZCode app's BigModel account", fallback: true },
  zai: { index: 2, source: "ZCode app's Z.AI account", fallback: true },
};
export function methodDetails(channel, index, method) {
  const entry = local[channel];
  if (entry?.index === index)
    return {
      kind: "local",
      description: `Follows ${entry.source} on this Host. ${["bigmodel", "zai"].includes(channel) ? "Only the same account and team credentials are renewed; detect again after switching account, organization or project. " : ""}${entry.fallback ? "Keeps the imported snapshot if the source signs out." : "The source must remain signed in."}${entry.writeback ? " Refreshed credentials are written back to the source." : ""}`,
    };
  return {
    kind: method.type === "api" ? "credentials" : "browser",
    ...(typeof method.description === "string" ? { description: method.description } : {}),
  };
}
export const factoryImportMethod = {
  id: "import-files",
  label: "Import Factory API key files",
  type: "api",
  kind: "import",
  description:
    "Import Factory keys from text, env or JSON files. Each key is verified with Factory; files are not followed after import.",
};

export function promptApplies(prompt, inputs) {
  if (prompt.when) {
    const value = inputs[prompt.when.key];
    if (value === undefined) return false;
    if (prompt.when.op === "eq" ? value !== prompt.when.value : value === prompt.when.value)
      return false;
  }
  if (typeof prompt.condition === "function") return Boolean(prompt.condition(inputs));
  if (prompt.condition) return inputs[prompt.condition.key] === prompt.condition.value;
  return true;
}
export function promptField(prompt) {
  const condition =
    typeof prompt.condition === "object"
      ? prompt.condition
      : prompt.when?.op === "eq"
        ? prompt.when
        : undefined;
  const value = prompt.defaultValue ?? prompt.default;
  return {
    key: prompt.key,
    label: prompt.message || prompt.key,
    type: ["select", "password"].includes(prompt.type) ? prompt.type : "text",
    ...(prompt.options
      ? {
          options: prompt.options.map(({ label, value, hint }) => ({
            label,
            value,
            ...(typeof hint === "string" ? { hint } : {}),
          })),
        }
      : {}),
    ...(prompt.optional === true ? { optional: true } : {}),
    ...(typeof prompt.placeholder === "string" ? { placeholder: prompt.placeholder } : {}),
    ...(typeof value === "string" ? { defaultValue: value } : {}),
    ...(condition ? { condition: { key: condition.key, value: condition.value } } : {}),
  };
}
