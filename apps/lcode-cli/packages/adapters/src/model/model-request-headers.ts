/** HTTP 头名不区分大小写；后来的值替换旧值，避免不同大小写被 SDK 拼成重复头。 */
export function mergeModelRequestHeaders(
  ...sources: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
      headers[name] = value;
    }
  }
  return headers;
}
