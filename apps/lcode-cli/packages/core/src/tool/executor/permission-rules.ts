import type { PermissionRuleset, PermissionUpdate } from "@lcode/contracts";

export function applyPermissionUpdates(
  current: PermissionRuleset,
  updates: PermissionUpdate[],
): PermissionRuleset {
  let next: PermissionRuleset = {
    ...current,
    version: 1,
  };

  for (const update of updates) {
    if (update.type !== "addRules") continue;
    const existing = getPermissionRules(next, update.behavior);
    next = {
      ...next,
      [update.behavior]: dedupePermissionRules([...existing, ...update.rules]),
    };
  }

  return next;
}

function getPermissionRules(
  ruleset: PermissionRuleset,
  behavior: PermissionUpdate["behavior"],
): NonNullable<PermissionRuleset["allow"]> {
  const rules = ruleset[behavior];
  return Array.isArray(rules) ? rules : [];
}

function dedupePermissionRules(
  rules: NonNullable<PermissionRuleset["allow"]>,
): NonNullable<PermissionRuleset["allow"]> {
  const seen = new Set<string>();
  const deduped: NonNullable<PermissionRuleset["allow"]> = [];

  for (const rule of rules) {
    const key = `${rule.toolName}\u0000${rule.ruleContent ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(rule);
  }

  return deduped;
}
