import { connect, createServer, type Server } from "node:net";
import { stripVTControlCharacters } from "node:util";
import { serviceUrlOrigin } from "../domain/services.js";

export function managedProcessError(code: string): Error & { code: string } {
  const messages: Record<string, string> = {
    "port-bind-failed": "port-bind-failed: EADDRINUSE or invalid declared service port",
    cancelled: "cancelled: managed service startup aborted",
    "process-unknown": "process-unknown: owned process tree exit is not confirmed",
    "spawn-failed": "managed service startup failed before listening",
    unhealthy: "managed service startup did not verify every listening address",
    "configuration-conflict": "configuration-conflict: invalid trusted managed service definition",
  };
  return Object.assign(new Error(messages[code] ?? messages["spawn-failed"]), { code });
}

/** 同时持有候选 socket 避免组内重复；关闭预留后仍须从 stdout + 健康检查确认真实 bind。 */
export async function reserveLoopbackPorts(
  count: number,
  requested?: readonly number[],
): Promise<number[]> {
  if (count > 16 || (requested && requested.length !== count))
    throw managedProcessError("configuration-conflict");
  const reservations: Server[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const port = requested?.[index] ?? 0;
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
        throw managedProcessError("port-bind-failed");
      const server = createServer();
      reservations.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", () => reject(managedProcessError("port-bind-failed")));
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw managedProcessError("port-bind-failed");
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(
      reservations.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) return resolve();
            server.close(() => resolve());
          }),
      ),
    );
  }
}

/** 不留原始日志：两条流各最多 8 KiB，仅提取白名单 loopback origin 和 bind 错误标签。 */
export function createServiceOutput(expectedPorts: readonly number[]) {
  const tails = { stdout: "", stderr: "" };
  const addresses = new Map<number, string>();
  let bindFailed = false;
  return {
    consume(stream: "stdout" | "stderr", chunk: Buffer) {
      const text = chunk.toString("utf8", Math.max(0, chunk.length - 8192));
      const tail = stripVTControlCharacters(tails[stream] + text).slice(-8192);
      tails[stream] = tail;
      bindFailed ||= /EADDRINUSE|address already in use|port \d+ is already in use/iu.test(tail);
      for (const match of tail.matchAll(/https?:\/\/[^\s"'<>]+/gu)) {
        const origin = serviceUrlOrigin(match[0]);
        if (!origin) continue;
        const url = new URL(origin);
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        if (expectedPorts.length && !expectedPorts.includes(port)) continue;
        if (addresses.size < 16) addresses.set(port, origin);
      }
    },
    bindFailed: () => bindFailed,
    urls: () =>
      expectedPorts.length
        ? expectedPorts.every((port) => addresses.has(port))
          ? expectedPorts.map((port) => addresses.get(port)!)
          : []
        : [...addresses.values()],
    clear() {
      tails.stdout = "";
      tails.stderr = "";
    },
  };
}

export async function probeServiceListener(value: string): Promise<boolean> {
  const origin = serviceUrlOrigin(value);
  if (!origin) return false;
  const url = new URL(origin);
  return new Promise((resolve) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    const finish = (healthy: boolean) => {
      socket.destroy();
      resolve(healthy);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function withinBudget<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
