import { spawn } from "node:child_process";
import type { TuiWriteClipboardText } from "@lcode/tui";

const DEFAULT_MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;
const OSC_52_CLIPBOARD_TARGET = "c";
const OSC_52_PREFIX = "\x1b]52;";
const OSC_52_SUFFIX = "\x07";
const POWERSHELL_SET_CLIPBOARD = "Set-Clipboard -Value ([Console]::In.ReadToEnd())";

type CommandResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
};

type TextCommandRunner = (
  file: string,
  args: string[],
  options: {
    input: string;
  },
) => Promise<CommandResult>;

type ClipboardTextOutput = {
  write: (chunk: string) => boolean;
};

type NodeClipboardTextWriterOptions = {
  maxBytes?: number;
  platform?: NodeJS.Platform;
  runCommand?: TextCommandRunner;
  stdout?: ClipboardTextOutput;
};

export function createNodeClipboardTextWriter(
  options: NodeClipboardTextWriterOptions = {},
): TuiWriteClipboardText {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CLIPBOARD_TEXT_BYTES;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? runCommandText;

  return async (text) => {
    const buffer = assertClipboardTextSize(text, maxBytes);
    if (buffer.byteLength === 0) return;

    const wroteOsc52 = writeOsc52(options.stdout, buffer);
    const copiedNative = await writeNativeClipboardText({
      input: text,
      platform,
      runCommand,
    });

    if (!wroteOsc52 && !copiedNative) {
      throw new Error("No text clipboard target accepted the selected text.");
    }
  };
}

function writeOsc52(stdout: ClipboardTextOutput | undefined, buffer: Buffer): boolean {
  if (!stdout) return false;
  try {
    stdout.write(
      `${OSC_52_PREFIX}${OSC_52_CLIPBOARD_TARGET};${buffer.toString("base64")}${OSC_52_SUFFIX}`,
    );
    return true;
  } catch {
    return false;
  }
}

async function writeNativeClipboardText(options: {
  input: string;
  platform: NodeJS.Platform;
  runCommand: TextCommandRunner;
}): Promise<boolean> {
  for (const command of nativeClipboardCommands(options.platform)) {
    const result = await options.runCommand(command.file, command.args, {
      input: options.input,
    });
    if (result.exitCode === 0) return true;
  }
  return false;
}

function nativeClipboardCommands(platform: NodeJS.Platform): Array<{
  args: string[];
  file: string;
}> {
  if (platform === "darwin") {
    return [{ args: [], file: "pbcopy" }];
  }
  if (platform === "linux") {
    return [
      { args: [], file: "wl-copy" },
      { args: ["-selection", "clipboard"], file: "xclip" },
      { args: ["--clipboard", "--input"], file: "xsel" },
    ];
  }
  if (platform === "win32") {
    return [
      {
        args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SET_CLIPBOARD],
        file: "powershell.exe",
      },
    ];
  }
  return [];
}

function assertClipboardTextSize(text: string, maxBytes: number): Buffer {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Clipboard text exceeds ${maxBytes} bytes.`);
  }
  return buffer;
}

async function runCommandText(
  file: string,
  args: string[],
  options: {
    input: string;
  },
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ exitCode: -1 });
      return;
    }

    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
    child.on("error", () => finish({ exitCode: -1 }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}
