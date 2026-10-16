import type { AuthDriver, AuthDriverNetworkOptions } from "./driver.js";
import { createHostApiNetworkTransport } from "../provider-network.js";
import { createOwnedAuthDriver } from "./owned-driver.js";
import { AuthAuthorizationTracker } from "./authorization-tracker.js";
export * from "./driver.js";
export { readAuthorizationDiagnostic } from "./authorization-diagnostics.js";
export { createAuthModelOptionSpecs } from "./model-options.js";
export async function createAuthDriver(
  channelId: string,
  options?: AuthDriverNetworkOptions,
): Promise<AuthDriver> {
  const network = options ? createHostApiNetworkTransport(options.resolveNetwork) : undefined;
  const tracker = new AuthAuthorizationTracker();
  const owned = await createOwnedAuthDriver(async () => {
    const driver =
      (await (
        await import("./native.js")
      ).createNativeAuthDriver(
        channelId,
        tracker.fetch(network?.fetch ?? globalThis.fetch),
        options,
      )) ?? (await (await import("./plugins.js")).createPluginAuthDriver(channelId, options));
    if (!driver) throw new Error(`Unsupported authorization channel: ${channelId}`);
    return driver;
  }, network);
  return {
    ...owned,
    authorize: (method, inputs, signal, observe) =>
      tracker.authorize(() => owned.authorize(method, inputs, signal, observe), observe),
  };
}
