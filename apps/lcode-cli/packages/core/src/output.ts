import type { JsonValue } from "@lcode/shared-types";

export { type JsonValue };

export const formatJson = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

export const supportsColor = (stream: NodeJS.WriteStream, noColor: boolean): boolean => {
  if (noColor) {
    return false;
  }

  return Boolean(stream.isTTY);
};

export const color = {
  bold: (text: string, enabled: boolean) => (enabled ? `\x1b[1m${text}\x1b[22m` : text),
  cyan: (text: string, enabled: boolean) => (enabled ? `\x1b[36m${text}\x1b[39m` : text),
  dim: (text: string, enabled: boolean) => (enabled ? `\x1b[2m${text}\x1b[22m` : text),
  green: (text: string, enabled: boolean) => (enabled ? `\x1b[32m${text}\x1b[39m` : text),
  red: (text: string, enabled: boolean) => (enabled ? `\x1b[31m${text}\x1b[39m` : text),
};
