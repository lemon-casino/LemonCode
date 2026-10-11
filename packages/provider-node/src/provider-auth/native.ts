import type { AuthDriver } from "./driver.js";
import { OpenAIAuthDriver } from "./native/openai.js";
import { CopilotAuthDriver } from "./native/copilot.js";
import { GoogleAuthDriver } from "./native/google.js";
import { ClaudeAuthDriver } from "./native/claude.js";

export async function createNativeAuthDriver(channelId: string): Promise<AuthDriver | null> {
  switch (channelId) {
    case "codex":
    case "chatgpt-api":
      return new OpenAIAuthDriver(channelId);
    case "copilot":
      return new CopilotAuthDriver();
    case "gemini":
    case "antigravity":
      return new GoogleAuthDriver(channelId);
    case "claude":
      return new ClaudeAuthDriver();
    default:
      return null;
  }
}
