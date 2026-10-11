// Adapted from Magpie internal/provider/factory_key.go (MIT; see native/LICENSE.magpie).
const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const KEY = /\bfk-[A-Za-z0-9_-]{8,}/g;

export async function factoryImports(serialized, options = {}) {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_TOTAL * 6 + 65536)
    throw new Error("Import exceeds the allowed size");
  let files;
  try {
    files = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid import files");
  }
  if (!Array.isArray(files) || !files.length || files.length > 200)
    throw new Error("Choose between 1 and 200 import files");
  let total = 0;
  const seen = new Set();
  const items = [];
  for (const [index, file] of files.entries()) {
    if (!file || typeof file.content !== "string" || typeof file.name !== "string")
      throw new Error("Invalid import file");
    const size = Buffer.byteLength(file.content);
    total += size;
    if (size > MAX_FILE || total > MAX_TOTAL) throw new Error("Import exceeds the allowed size");
    const keys = file.content.match(KEY) ?? [];
    const label = `File ${index + 1}`;
    if (!keys.length)
      items.push({ result: { status: "failed", label, error: "No Factory API keys found" } });
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 200) throw new Error("Import contains more than 200 accounts");
      items.push({ key, label });
    }
  }
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(180_000)].filter(Boolean));
  signal.throwIfAborted();
  const fetcher = options.fetch ?? globalThis.fetch;
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        signal.throwIfAborted();
        const index = next++;
        const item = items[index];
        if (item.result) {
          results[index] = item.result;
          continue;
        }
        try {
          const response = await fetcher("https://api.factory.ai/api/cli/whoami", {
            headers: { Authorization: `Bearer ${item.key}`, "X-Factory-Whoami-Extended": "true" },
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("refused");
          }
          const who = await response.json();
          signal.throwIfAborted();
          const user = typeof who.userId === "string" && who.userId.trim();
          const email = typeof who.email === "string" && who.email.trim();
          const org = typeof who.orgId === "string" ? who.orgId : "";
          if (!user && !email) throw new Error("identity unavailable");
          const metadata = {
            userId: user || "",
            email: email || "",
            region: typeof who.region === "string" ? who.region : "",
            premBaseHost: typeof who.premBaseHostV2 === "string" ? who.premBaseHostV2 : "",
          };
          results[index] = {
            status: "ready",
            label: email || user,
            grant: {
              type: "api",
              key: item.key,
              metadata,
              accountId: email || user,
              identityKey: `factory:${JSON.stringify([user || email, org])}`,
            },
          };
        } catch {
          signal.throwIfAborted();
          // 厂商错误和原始key可能相互回显；导入结果只保留固定安全文案。
          results[index] = {
            status: "failed",
            label: item.label,
            error: "Factory could not verify this account",
          };
        }
      }
    }),
  );
  signal.throwIfAborted();
  return results;
}
