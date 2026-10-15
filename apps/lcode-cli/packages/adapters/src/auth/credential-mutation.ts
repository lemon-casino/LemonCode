import type { LCodeCredentialCipher } from "./credential-cipher.js";

export function validateCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) throw new Error("Credential key must not be empty");
  return trimmed;
}

export function validateCredentialValue(value: string): string {
  if (value.length === 0) throw new Error("Credential value must not be empty");
  return value;
}

/** 仅准备比较与变更；实际执行始终在 Shared Store 原文件锁内。 */
export function prepareConditionalCredentialMutation(
  expected: Readonly<Record<string, string | null>>,
  entries: Readonly<Record<string, string>>,
  cipher: LCodeCredentialCipher,
): (raw: Record<string, string>) => boolean {
  const guards = Object.entries(expected).map(
    ([key, value]) =>
      [validateCredentialKey(key), value === null ? null : validateCredentialValue(value)] as const,
  );
  if (!guards.length) throw new Error("Conditional credential publication requires a snapshot");
  const encrypted = Object.entries(entries).map(
    ([key, value]) =>
      [validateCredentialKey(key), cipher.encrypt(validateCredentialValue(value))] as const,
  );
  return (raw) => {
    if (
      guards.some(
        ([key, value]) => (raw[key] === undefined ? null : cipher.decrypt(raw[key])) !== value,
      )
    )
      return false;
    for (const [key, value] of encrypted) raw[key] = value;
    return true;
  };
}
