export function encodeJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function decodeJson<T>(value: string | null): T | undefined {
  return value ? (JSON.parse(value) as T) : undefined;
}
