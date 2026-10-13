import { RateLimitWindow, readRateLimitHint } from "./rate-limit.js";
export async function waitForSharedProviderCooldown(
  headers: Headers,
  signal: AbortSignal,
): Promise<void> {
  const owner = new RateLimitWindow();
  try {
    owner.extend(readRateLimitHint(headers).delayMs);
    await owner.wait(signal);
  } finally {
    owner.dispose();
  }
}
