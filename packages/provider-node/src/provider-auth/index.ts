import type { AuthDriver, AuthDriverNetworkOptions } from "./driver.js";
import { createHostApiNetworkTransport } from "../provider-network.js";
export * from "./driver.js";
export { createAuthModelOptionSpecs } from "./model-options.js";
export async function createAuthDriver(
  channelId: string,
  options?: AuthDriverNetworkOptions,
): Promise<AuthDriver> {
  const network = options ? createHostApiNetworkTransport(options.resolveNetwork) : undefined;
  const driver =
    (await (
      await import("./native.js")
    ).createNativeAuthDriver(channelId, network?.fetch, options)) ??
    (await (await import("./plugins.js")).createPluginAuthDriver(channelId, options));
  if (!driver) throw new Error(`Unsupported authorization channel: ${channelId}`);
  if (network) {
    const dispose = driver.dispose?.bind(driver);
    driver.dispose = async () => {
      await dispose?.();
      network.dispose();
    };
  }
  return driver;
}
