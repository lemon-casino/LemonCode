import type {
  Locale,
  ProviderAccountChannel,
  ProviderAccountField,
  ProviderAccountMethod,
} from "@lcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

const providers: Readonly<Record<string, string>> = {
  bigmodel: "BigModel",
  zai: "Z.AI",
  codex: "ChatGPT",
  "chatgpt-api": "ChatGPT",
  copilot: "GitHub",
  gemini: "Google",
  antigravity: "Google",
  claude: "Claude Code",
  cline: "Cline",
  "commandcode-plan": "Command Code",
  cursor: "Cursor",
  devin: "Devin",
  factory: "Factory",
  grok: "Grok Build",
  kiro: "Kiro",
  "minimax-code": "MiniMax Code",
  "minimax-code-global": "MiniMax Code (Global)",
  "mimo-app": "小米",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  "trae-cn": "Trae CN",
  "trae-global": "Trae Global",
  workbuddy: "WorkBuddy",
  "workbuddy-ai": "WorkBuddy AI",
  zed: "Zed",
};
const sources: Readonly<Record<string, string>> = {
  bigmodel: "ZCode",
  zai: "ZCode",
  codex: "Codex",
  copilot: "Copilot 编辑器或 CLI",
  gemini: "Gemini CLI",
  claude: "Claude Code",
  "commandcode-plan": "Command Code CLI",
  cursor: "cursor-agent",
  devin: "Devin CLI",
  grok: "Grok Build",
  kiro: "Kiro CLI 或 IDE",
  workbuddy: "WorkBuddy",
  "workbuddy-ai": "WorkBuddy AI",
};
const localDescriptions: Readonly<Record<string, string>> = {
  bigmodel: "zcode",
  zai: "zcode",
  codex: "codex",
  copilot: "copilot",
  gemini: "gemini",
  claude: "claude",
  "commandcode-plan": "snapshot",
  devin: "snapshot",
  kiro: "kiro",
  cursor: "client",
  grok: "client",
  workbuddy: "client",
  "workbuddy-ai": "client",
};
const importDescriptions: Readonly<Record<string, string>> = {
  codex: "codexFiles",
  claude: "claudeFiles",
  gemini: "googleFiles",
  antigravity: "googleFiles",
  factory: "factoryFiles",
};
const copy = (intl: IntlInstance, key: string, values?: Record<string, string | number>) =>
  intl.formatMessage({ id: `settings.oauth.copy.${key}` }, values);

function localizeField(field: ProviderAccountField, intl: IntlInstance): ProviderAccountField {
  const labels: Readonly<Record<string, string>> = {
    key: "key",
    credentials: "credentials",
    token: "token",
    host: "host",
    projectId: "project",
    vpc: "vpc",
  };
  const label = labels[field.key];
  if (!label) return field;
  return {
    ...field,
    label: copy(intl, label),
    ...(field.key === "vpc" ? { placeholder: copy(intl, "vpcPlaceholder") } : {}),
  };
}

// 固定插件返回英文文案；只在显示层翻译，不能把翻译后的字段或方法名当作提交契约。
export function localizeAuthorizationChannel(
  channel: ProviderAccountChannel,
  locale: Locale,
  intl: IntlInstance,
): ProviderAccountChannel {
  const provider = providers[channel.id];
  if (locale !== "zh-CN" || !provider) return channel;
  return {
    ...channel,
    methods: channel.methods.map((method) => {
      const source = sources[channel.id] ?? provider;
      let label = method.label;
      let description = method.description;
      if (method.kind === "local") {
        label = copy(intl, "local", { source });
        description = copy(intl, `description.${localDescriptions[channel.id] ?? "client"}`, {
          source,
          provider,
        });
      } else if (method.kind === "import") {
        label = copy(intl, "files", { provider });
        const key = importDescriptions[channel.id];
        if (key) description = copy(intl, `description.${key}`);
      } else if (method.kind === "credentials") {
        label = copy(
          intl,
          method.type === "api" ? "api" : channel.id === "copilot" ? "githubToken" : "json",
          { provider },
        );
      } else if (method.kind === "browser") {
        const key =
          channel.id === "claude"
            ? "claudeBrowser"
            : channel.id === "kiro"
              ? "kiroBrowser"
              : channel.id === "qoder-cn" && method.id === "1"
                ? "vpcBrowser"
                : ["factory", "grok", "copilot"].includes(channel.id)
                  ? "deviceBrowser"
                  : "browser";
        label = copy(intl, key, { provider });
        if (["workbuddy", "workbuddy-ai"].includes(channel.id))
          description = copy(intl, "description.workbuddyBrowser", { provider });
      }
      return {
        ...method,
        label,
        ...(description ? { description } : {}),
        ...(method.fields
          ? { fields: method.fields.map((field) => localizeField(field, intl)) }
          : {}),
      };
    }),
  };
}

export function localizeAuthorizationInstructions(
  channelId: string,
  method: ProviderAccountMethod | undefined,
  instructions: string | undefined,
  locale: Locale,
  intl: IntlInstance,
): string | undefined {
  const provider = providers[channelId];
  if (locale !== "zh-CN" || !provider || !instructions) return instructions;
  if (method?.kind === "local") {
    const path = /^Uses the account in (.+)\.$/u.exec(instructions)?.[1];
    if (path)
      return copy(intl, "instructions.file", { source: sources[channelId] ?? provider, path });
    const account = /^Grok Build is signed in as (.+)\.$/u.exec(instructions)?.[1];
    if (account) return copy(intl, "instructions.currentAccount", { provider, account });
    if (instructions === "Uses the account `cursor-agent login` signed in to.")
      return copy(intl, "instructions.cursor");
    if (
      instructions === "Grok Build is signed in." ||
      instructions === "Uses the account kiro-cli or the Kiro IDE is signed in to." ||
      instructions === "Uses the account the ZCode app is signed in to, and follows it." ||
      instructions ===
        "Follows renewed credentials for this ZCode account and team. Detect again after switching account or team; keeps the imported snapshot if ZCode signs out." ||
      /^Uses the account WorkBuddy(?: AI)? desktop is signed in to\.$/u.test(instructions)
    )
      return method.description ?? instructions;
    return instructions;
  }
  // 验证码来自本次challenge；仅匹配固定上游模板，保留完整值，未知格式继续显示原步骤。
  const codePatterns: Readonly<Record<string, RegExp>> = {
    copilot: /^Enter code: (.+)$/u,
    factory: /^Confirm the code (.+) on Factory's page$/u,
    cline: /^Approve the sign-in in the browser — the code is (.+)\.$/u,
    "minimax-code":
      /^Sign in to MiniMax Code in the browser and confirm the code (.+); this finishes by itself\.$/u,
    "minimax-code-global":
      /^Sign in to MiniMax Code \(Global\) in the browser and confirm the code (.+); this finishes by itself\.$/u,
  };
  const code = codePatterns[channelId]?.exec(instructions)?.[1];
  if (code) return copy(intl, "instructions.device", { provider, code });
  if (instructions === "Approve the sign-in in the browser.")
    return copy(intl, "instructions.browser", { provider });
  const staticInstructions: Readonly<Record<string, string>> = {
    "Sign in to Devin in the browser.": "browser",
    "Sign in to Cursor in the browser; this finishes by itself.": "browser",
    "Approve the key for this machine in Command Code Studio.": "commandcode",
    "Approve the sign-in on the page; Grok Build finishes it.": "grok",
    "Sign in to your Xiaomi account on the page that opens (or scan its QR code with the Xiaomi app). The sign-in finishes here by itself.":
      "xiaomi",
    "Sign in to Kiro with Google, GitHub, AWS Builder ID or IAM Identity Center.": "kiro",
    "Sign in to Zed in the browser; it comes back here when you're done.": "browser",
  };
  const key = staticInstructions[instructions];
  if (key) return copy(intl, `instructions.${key}`, { provider });
  if (
    /^Sign in to (?:WorkBuddy(?: AI)?|Z\.ai|BigModel) in the browser; this finishes (?:by itself|on its own)\.$/u.test(
      instructions,
    ) ||
    /^Sign in to Qoder(?: CN)?(?: Enterprise[^\n]*)? in the browser and authorize this device$/u.test(
      instructions,
    ) ||
    /^Sign in to Trae (?:CN|Global) \([^\n]+\) in the browser and allow the sign-in\. It finishes here by itself\.$/u.test(
      instructions,
    )
  )
    return copy(intl, "instructions.browser", { provider });
  if (
    instructions ===
    "Complete Claude Code sign-in in your browser. You can paste its code#state or callback URL."
  )
    return copy(intl, "instructions.claude");
  return instructions;
}
