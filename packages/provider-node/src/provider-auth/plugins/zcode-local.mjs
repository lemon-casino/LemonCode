// Site-scoped adaptation of pinned plugins/zcode's credential format; vendor/LICENSE applies.
import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const bases = {
  zai: "https://api.z.ai/api/anthropic",
  bigmodel: "https://open.bigmodel.cn/api/anthropic",
};
const text = (v) => (typeof v === "string" ? v.trim() : "");
const identity = (channel, state) =>
  text(state.userId)
    ? `zcode:${JSON.stringify([channel, text(state.userId), text(state.org), text(state.project)])}`
    : "";
const changed = () =>
  Object.assign(new Error("ZCode sign-in changed. Detect this account again."), {
    signIn: "expired",
  });
function sameAccount(channel, grant, saved, current) {
  if (text(saved.org) !== text(current.org) || text(saved.project) !== text(current.project))
    return false;
  const expected =
    text(grant.identityKey) ||
    identity(channel, { ...saved, userId: text(saved.userId) || text(grant.accountId) });
  if (expected) return expected === identity(channel, current);
  // 旧快照没有稳定身份时只认相同调用凭据，不把新发现的用户当成原账号。
  const before = text(saved.token) || text(saved.key) || text(saved.jwt) || text(grant.access);
  const after = text(current.token) || text(current.key) || text(current.jwt);
  return Boolean(before) && before === after;
}
async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
function decrypt(key, value) {
  if (typeof value !== "string" || !value.startsWith("enc:v1:")) return "";
  try {
    const parts = value.slice(7).split(".");
    if (parts.length !== 3) return "";
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
export async function readZCodeLocal(channel, options = {}) {
  if (!(channel in bases)) throw new Error("Unsupported ZCode site");
  const home = options.home ?? homedir();
  let seed = options.seed ?? process.env.ZCODE_CREDENTIAL_SECRET;
  if (!seed) {
    let name = "";
    try {
      name = userInfo().username;
    } catch {}
    seed = `zcode-credential-fallback:${process.platform}:${home}:${name.slice(name.lastIndexOf("\\") + 1)}`;
  }
  const key = createHash("sha256").update(seed).digest();
  const directory = join(home, ".zcode", "v2");
  const [store, settings] = await Promise.all([
    json(join(directory, "credentials.json")),
    json(join(directory, "setting.json")),
  ]);
  if (!store || typeof store !== "object" || Array.isArray(store)) return null;
  const read = (name) => decrypt(key, store[name]);
  let apiKey = "";
  for (const [name, value] of Object.entries(store)) {
    if (!name.includes(":coding-plan:") || !name.endsWith(":api-key")) continue;
    if ((name.includes(":bigmodel-") ? "bigmodel" : "zai") !== channel) continue;
    const candidate = decrypt(key, value);
    if (candidate.includes(".")) {
      apiKey = candidate;
      break;
    }
  }
  let info = {};
  try {
    info = JSON.parse(read(`oauth:${channel}:user_info`) || "{}");
  } catch {}
  const user = text(info?.email) || text(info?.name) || text(info?.user_id);
  const userId = text(info?.user_id) || text(info?.email);
  const selected = settings?.providerFamilyConnectionSelections?.[channel];
  let org = "";
  let project = "";
  if (selected?.kind === "team-coding-plan") {
    org = text(selected.organizationId);
    project = text(selected.projectId);
  } else if (!selected) {
    const legacy = text(settings?.modelProviderFamilySelectedKeys?.[channel]);
    const prefix = `team-plan:builtin:${channel}-coding-plan:`;
    if (legacy.startsWith(prefix)) {
      const parts = legacy.slice(prefix.length).split(":");
      if (parts.length === 3)
        try {
          [org, project] = parts.slice(1).map(decodeURIComponent);
        } catch {}
    }
  }
  const jwt = text(read("zcodejwttoken")).replace(/^Bearer /, "");
  const token = text(read(`oauth:${channel}:access_token`));
  const base = bases[channel];
  // 不能让另一站的优先key/团队选择覆盖当前channel；不更改进程环境或外部文件。
  if (org && project && token && !(channel === "bigmodel" && token === jwt))
    return { site: channel, base, key: "", token, org, project, jwt, user, userId };
  if (!apiKey && !(channel === "zai" && jwt)) return null;
  return { site: channel, base, key: apiKey, jwt: channel === "zai" ? jwt : "", user, userId };
}
export async function resolveZCodeLocal(channel, grant, options) {
  if (!(channel in bases) || grant?.type !== "oauth") return grant;
  let state;
  try {
    state = JSON.parse(grant.refresh || "{}");
  } catch {
    return grant;
  }
  if (!["zcode", "zcode-channel"].includes(state.source)) return grant;
  if (state.site && state.site !== channel) throw changed();
  const own = await readZCodeLocal(channel, options);
  // 跟随凭据续期不能跟随换账号/组织/项目，否则旧connection的用量会被归到新身份。
  if (own && !sameAccount(channel, grant, state, own)) throw changed();
  const next = own
    ? { device: state.device, plan: state.plan, ...own, source: "zcode-channel" }
    : { ...state, source: "zcode-channel", site: channel };
  return {
    ...grant,
    access: next.key || next.jwt || grant.access || "",
    refresh: JSON.stringify(next),
  };
}
export function zcodeLocalChallenge(channel, options) {
  return {
    method: "auto",
    instructions:
      "Follows renewed credentials for this ZCode account and team. Detect again after switching account or team; keeps the imported snapshot if ZCode signs out.",
    async callback() {
      const own = await readZCodeLocal(channel, options);
      if (!own) return { type: "failed", error: "ZCode has no signed-in account for this site" };
      const identityKey = identity(channel, own);
      return {
        type: "success",
        access: own.key || own.jwt || "",
        refresh: JSON.stringify({ ...own, source: "zcode-channel" }),
        expires: 0,
        ...(own.userId ? { accountId: own.userId } : {}),
        ...(identityKey ? { identityKey } : {}),
      };
    },
  };
}
