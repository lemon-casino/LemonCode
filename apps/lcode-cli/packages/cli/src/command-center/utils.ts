export function splitArgs(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part.toLowerCase() : part));
}

export function shortText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function shortId(id: string): string {
  return id.length <= 18 ? id : `${id.slice(0, 15)}...`;
}

export function formatTime(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").slice(0, 16);
}
