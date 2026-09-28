import type {
  BrowserCommand,
  BrowserCommandResult,
} from "@lcode/contracts/browser-control";

export class BrowserCommandError extends Error {
  readonly code: string;
  readonly command: BrowserCommand;
  readonly result: BrowserCommandResult;

  constructor(command: BrowserCommand, result: BrowserCommandResult, fallbackCode: string) {
    const code = result.error?.code ?? fallbackCode;
    super(result.error?.message ?? `Browser command failed: ${code}`);
    this.name = "BrowserCommandError";
    this.code = code;
    this.command = command;
    this.result = result;
  }
}

export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export function expectOk(
  command: BrowserCommand,
  result: BrowserCommandResult,
): BrowserCommandResult {
  if (!result.ok) {
    throw new BrowserCommandError(command, result, "browser_command_failed");
  }
  return result;
}

export function expectPayload<T>(
  command: BrowserCommand,
  result: BrowserCommandResult,
  value: T | undefined,
  payloadName: string,
): T {
  expectOk(command, result);
  if (value === undefined) {
    throw new BrowserCommandError(
      command,
      {
        ...result,
        ok: false,
        error: { code: "execution_error", message: `Browser result missing ${payloadName}` },
      },
      "execution_error",
    );
  }
  return value;
}
