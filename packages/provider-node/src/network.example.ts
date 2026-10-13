import { createProviderNetworkTransport } from "./network.js";

/** 网络契约示例：owner 关闭前等待 body，退出始终释放所属池。 */
export async function readNetworkFixture(url: string): Promise<string> {
  const transport = createProviderNetworkTransport(async () => ({ forceDirect: true }));
  try {
    return await (await transport.fetch(url)).text();
  } finally {
    await transport.disposeAndWait();
  }
}
