import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEncodedPowerShellArgs } from "../../scripts/powershell-command.mjs";

const SYSTEM_CREDENTIAL_TIMEOUT_MS = 15_000;
// macOS `security` 会把 OSStatus 压缩为 8 位进程退出码：
// errSecInteractionNotAllowed(-25308) -> 36、errSecAuthFailed(-25293) -> 51、
// errSecUserCanceled(-128) -> 128。三者都表示本次用户授权未完成。
const MAC_KEYCHAIN_ACCESS_DENIED_EXIT_CODES = new Set([36, 51, 128]);

export type MacChromeSafeStorageSecretReader = () => Promise<string>;

export class ChromeCookieAccessDeniedError extends Error {
  readonly code = "chrome_cookie_access_denied";

  constructor() {
    super("chrome_cookie_access_denied");
    this.name = "ChromeCookieAccessDeniedError";
  }
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        // 系统凭据授权窗口可能被遮挡或无人处理，不能永久阻塞导入流程。
        timeout: SYSTEM_CREDENTIAL_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function isMacKeychainAccessDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "number" && MAC_KEYCHAIN_ACCESS_DENIED_EXIT_CODES.has(code);
}

export async function readMacChromeSafeStorageSecret(
  secretReader: MacChromeSafeStorageSecretReader = () =>
    execFileText("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"]),
): Promise<string> {
  try {
    // secret 只在 main 内存中消费，不得进入日志或 IPC。
    return await secretReader();
  } catch (error) {
    // 用户拒绝/取消钥匙串授权是整个导入的终止信号，不能被当成普通单条
    // Cookie 解密失败吞掉，否则上层会继续写入 LocalStorage，违背用户的明确选择。
    if (isMacKeychainAccessDenied(error)) throw new ChromeCookieAccessDeniedError();
    throw error;
  }
}

export async function readWindowsChromeMasterKey(userDataDir: string): Promise<Buffer> {
  const localState = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encryptedKey = localState.os_crypt?.encrypted_key;
  if (!encryptedKey) throw new Error("chrome_master_key_missing");
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$data=[Convert]::FromBase64String($lcodeArg0);",
    "if ([Text.Encoding]::ASCII.GetString($data,0,5) -eq 'DPAPI') {$data=$data[5..($data.Length-1)]};",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($plain)",
  ].join("");
  // 普通 `-Command` 不会把尾随 encryptedKey 注入 `$args`，Windows 导入会拿到空参数。
  // 使用统一 EncodedCommand 传值，避免命令行二次解析并保留 DPAPI 密文边界。
  const output = await execFileText(
    "powershell.exe",
    createEncodedPowerShellArgs(script, [encryptedKey]),
  );
  return Buffer.from(output, "base64");
}
