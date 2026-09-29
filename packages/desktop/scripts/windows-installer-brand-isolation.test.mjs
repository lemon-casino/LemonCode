import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("Windows 安装器用产品 exe 名限定进程关闭范围，不按共同父目录扫描", async () => {
  const installerSource = await readFile(`${desktopRoot}/build/installer.nsh`, "utf8");

  assert.match(installerSource, /!macro customCheckAppRunning/);
  assert.match(installerSource, /Var \/GLOBAL IsPowerShellAvailable/);
  assert.match(installerSource, /StrCpy \$IsPowerShellAvailable "1"/);
  assert.match(installerSource, /!insertmacro _CHECK_APP_RUNNING/);
});

test("electron-builder 模板检测到自定义进程宏时跳过默认路径前缀实现", async () => {
  const templateSource = await readFile(
    `${repositoryRoot}/node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh`,
    "utf8",
  );

  assert.match(templateSource, /!ifmacrondef customCheckAppRunning/);
  assert.match(
    templateSource,
    /!ifmacrodef customCheckAppRunning[\s\S]*!insertmacro customCheckAppRunning/,
  );
  assert.match(templateSource, /\.Path\.StartsWith\('\$INSTDIR'/);
});
