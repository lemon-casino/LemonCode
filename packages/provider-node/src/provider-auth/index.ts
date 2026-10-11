import type { AuthDriver } from "./driver.js";
export * from "./driver.js";
export { createAuthModelOptionSpecs } from "./model-options.js";
export async function createAuthDriver(channelId: string): Promise<AuthDriver> {
  const driver =
    (await (await import("./native.js")).createNativeAuthDriver(channelId)) ??
    (await (await import("./plugins.js")).createPluginAuthDriver(channelId));
  if (!driver) throw new Error(`Unsupported authorization channel: ${channelId}`);
  return driver;
}
