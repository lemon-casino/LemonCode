import { Emitter, VSBuffer, type ISocket } from "@lcode/rpc";
import type { StdioStream } from "./backend.js";

/**
 * Wrap a StdioStream (from IRemoteBackend.exec()) as an ISocket
 * for use with SocketProtocol → ChannelClient → RemoteServiceAccess.
 *
 * Follows the same pattern as wrapWebSocket in packages/server/src/http.ts
 * and wrapBrowserWebSocket in packages/client/src/websocket.ts.
 */
export function wrapStdioStream(stream: StdioStream): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  stream.stdout.on("data", (chunk: Buffer) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(chunk)));
  });

  stream.stdout.on("end", () => {
    onEnd.fire();
  });

  stream.onClose(() => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      stream.stdin.write(Buffer.from(buffer.buffer));
    },
    end() {
      stream.stdin.end();
    },
    drain() {
      const stdin = stream.stdin as NodeJS.WritableStream & {
        writableNeedDrain?: boolean;
        once(event: "drain", listener: () => void): unknown;
      };
      return new Promise<void>((resolve) => {
        if (stdin.writableNeedDrain) {
          stdin.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      stream.stdin.end();
    },
  };
}
