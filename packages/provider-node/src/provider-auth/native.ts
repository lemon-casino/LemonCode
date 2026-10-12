import type { AuthDriver, AuthDriverNetworkOptions } from "./driver.js";
import { spawnClaude } from "./native/claude-process.js";
import { OpenAIAuthDriver } from "./native/openai.js";
import { CopilotAuthDriver } from "./native/copilot.js";
import { GoogleAuthDriver } from "./native/google.js";
import { ClaudeAuthDriver } from "./native/claude.js";

export async function createNativeAuthDriver(
  channelId: string,
  fetcher?: typeof fetch,
  options?: AuthDriverNetworkOptions,
): Promise<AuthDriver | null> {
  switch (channelId) {
    case "codex":
    case "chatgpt-api":
      return new OpenAIAuthDriver(channelId, fetcher);
    case "copilot":
      return new CopilotAuthDriver(fetcher);
    case "gemini":
    case "antigravity":
      return new GoogleAuthDriver(channelId, fetcher);
    case "claude":
      return new ClaudeAuthDriver(
        options
          ? async (args, dir, additions) => {
              const network = await options.resolveNetwork();
              // CLI 子进程也必须按账号供应商选择出口，不能沿用 Host 的另一代理。
              return spawnClaude(args, dir, {
                ...additions,
                HTTP_PROXY: network.httpProxy ?? "",
                HTTPS_PROXY: network.httpProxy ?? "",
                ALL_PROXY: "",
                http_proxy: network.httpProxy ?? "",
                https_proxy: network.httpProxy ?? "",
                all_proxy: "",
                NO_PROXY: network.noProxy ?? "",
                no_proxy: network.noProxy ?? "",
                ...(network.caCertPath ? { NODE_EXTRA_CA_CERTS: network.caCertPath } : {}),
              });
            }
          : undefined,
        undefined,
        fetcher,
      );
    default:
      return null;
  }
}
