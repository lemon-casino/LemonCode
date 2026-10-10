export function fishCwdCaptureCommand(command: string, path: string): string {
  const quotedPath = `'${path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  return [
    command,
    "set -l __lcode_status $status",
    `if test $__lcode_status -eq 0; pwd -P > ${quotedPath}; end`,
    "exit $__lcode_status",
  ].join("\n");
}

export function nushellCwdCaptureCommand(command: string, path: string): string {
  // Nu 的字符串不是 POSIX 引号；JSON 双引号保留 Windows 路径、中文及单引号。
  // do --env 让 cd 的变化返回外层；capture-errors 防止 print 消费外部流后掩盖非零退出。
  return [
    "do --env --capture-errors {",
    command,
    "} | print",
    `$env.PWD | save --force ${JSON.stringify(path)}`,
  ].join("\n");
}
