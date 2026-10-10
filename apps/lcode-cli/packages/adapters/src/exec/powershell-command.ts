const UTF8_ENCODING = "[System.Text.UTF8Encoding]::new($false)";
const CAPTURE_EXIT_STATUS = [
  "$__lcode_success = $?",
  "$__lcode_exit = if ($__lcode_success) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }",
].join("\n");

export function powerShellCommandArgs(command: string): string[] {
  // PowerShell 不能套用 bash -c、POSIX 引号及退出包装；编码参数保留中文、引号和多行源码。
  const script = [
    `[Console]::InputEncoding = ${UTF8_ENCODING}`,
    `[Console]::OutputEncoding = ${UTF8_ENCODING}`,
    "$OutputEncoding = [Console]::OutputEncoding",
    "$ProgressPreference = 'SilentlyContinue'",
    "$global:LASTEXITCODE = 0",
    command,
    CAPTURE_EXIT_STATUS,
    "exit $__lcode_exit",
  ].join("\n");
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

export function powerShellCwdCaptureCommand(command: string, cwdFilePath: string): string {
  const quotedPath = `'${cwdFilePath.replaceAll("'", "''")}'`;
  return [
    command,
    CAPTURE_EXIT_STATUS,
    // 先保存 $?，再执行 IO；否则一次成功写文件会把真实命令失败掩盖成成功。
    "if ($__lcode_exit -eq 0 -and $PWD.Provider.Name -eq 'FileSystem') {",
    `  [System.IO.File]::WriteAllText(${quotedPath}, $PWD.ProviderPath, ${UTF8_ENCODING})`,
    "}",
    "exit $__lcode_exit",
  ].join("\n");
}
