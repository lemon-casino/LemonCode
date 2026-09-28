import type { LifecycleState } from "../contracts.js";

export async function waitForUpdateReady(
  readState: () => LifecycleState,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState();
    if (state === "ready") return;
    if (state === "crashed" || state === "crash-loop-stopped") {
      throw new Error("Server Core failed while applying update");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Server Core ready");
}
