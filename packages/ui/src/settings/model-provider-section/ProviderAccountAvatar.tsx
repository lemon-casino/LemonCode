import { ProviderLogo } from "./ProviderLogo.js";

const logoKeys: Readonly<Record<string, string>> = {
  bigmodel: "bigmodel",
  zai: "zai",
  codex: "openai",
  "chatgpt-api": "openai",
  claude: "anthropic",
  grok: "xai",
  "minimax-code": "minimax",
  "minimax-code-global": "minimax",
  "mimo-app": "xiaomi-mimo",
  copilot: "copilot",
  gemini: "gemini-cli",
  antigravity: "antigravity",
  cline: "cline",
  "commandcode-plan": "commandcode",
  cursor: "cursor",
  devin: "devin",
  factory: "factory",
  kiro: "kiro",
  qoder: "qoder",
  "qoder-cn": "qoder",
  "trae-cn": "trae",
  "trae-global": "trae",
  workbuddy: "workbuddy",
  "workbuddy-ai": "workbuddy",
  zed: "zed",
};

export function ProviderAccountAvatar({ channelId, name }: { channelId: string; name: string }) {
  const key = logoKeys[channelId];
  return (
    <span
      data-testid="oauth-provider-avatar"
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center"
    >
      {key ? (
        <ProviderLogo logo={{ type: "builtin", key }} className="size-6" />
      ) : (
        <span className="flex size-6 items-center justify-center rounded-md bg-hover text-ui-sm font-semibold text-foreground-subtle">
          {name.slice(0, 2).toUpperCase()}
        </span>
      )}
    </span>
  );
}
