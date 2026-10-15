import type { AuthMethod } from "@lcode/provider-node";

/** 授权表单的纯校验；不拥有 driver、账号或凭据状态。 */
export function prepareProviderAuthorizationInputs(
  method: AuthMethod,
  source: Record<string, string> = {},
): Record<string, string> {
  const inputs = { ...source };
  for (const field of method.fields ?? [])
    if (inputs[field.key] === undefined && field.defaultValue !== undefined)
      inputs[field.key] = field.defaultValue;
  for (const field of method.fields ?? []) {
    if (field.condition && inputs[field.condition.key] !== field.condition.value) continue;
    const value = inputs[field.key];
    if (!field.optional && !value?.trim()) throw new Error(`Required input: ${field.label}`);
    if (
      field.type === "select" &&
      value &&
      !field.options?.some((option) => option.value === value)
    )
      throw new Error(`Invalid input: ${field.label}`);
  }
  return inputs;
}
