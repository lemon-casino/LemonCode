export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 18)}\n...[truncated]`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
