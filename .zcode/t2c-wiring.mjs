// T2c：把品牌数据迁移接线到三个运行时入口（批次 2，一次性）
import fs from "node:fs";

// 1) desktop 早期引导：~/.zcode → ~/.lcode 必须先于 setting.json 读取
{
  const p = "packages/desktop/src/main/desktopEarlyDataBaseDirBootstrap.ts";
  fs.writeFileSync(
    p,
    `import { homedir } from "node:os";
import { migrateHomeBrandDataRootSync } from "@lcode/shared/node";
import { applyEarlyDataBaseDirBootstrap } from "./desktopDataBaseDirBootstrap.js";

// 品牌迁移（复制式、幂等）必须先于 setting.json 读取：旧 ~/.zcode/v2/setting.json 是
// dataBaseDir 自定义值的唯一来源，先迁移再引导，避免首次启动读不到自定义目录
// 而把日志/crash dump 写到两套路径（specs/brand-migration-lcode.md）。
migrateHomeBrandDataRootSync(process.env.LCODE_DESKTOP_HOME_DIR?.trim() || homedir());

applyEarlyDataBaseDirBootstrap();
`,
  );
  console.log(`ok ${p}`);
}

// 2) desktop main：appData 身份目录与 Chromium 分区迁移（在 setPath userData 之前）
{
  const p = "packages/desktop/src/main/desktopDataBaseDirBootstrap.ts";
  let c = fs.readFileSync(p, "utf8");
  if (!c.includes("migrateDesktopIdentityDataSync")) {
    c += `
// 品牌迁移（复制式、幂等）：旧 appData/<ZCode 系身份> → 新 appData/<LCode 系身份>，
// 并把旧 Chromium 分区目录迁到新分区名，避免丢嵌入式浏览器会话与 Coding Plan 登录态。
// 旧目录保留（并列安装形态下旧版应用继续读旧 appData，数据不受影响）。
export function migrateDesktopIdentityDataSync(): void {
  const appData = app.getPath("appData");
  // runtimeApplicationName 取 "LCode" | "LCode Preview" | "LCode Dev"；旧身份仅前缀不同。
  const legacyUserData = join(appData, runtimeApplicationName.replace(/^LCode/, "ZCode"));
  migrateDirCopyStyleSync(legacyUserData, runtimeUserDataPath);
  for (const [legacyPartition, partition] of [
    ["persist:zcode-embedded-browser", "persist:lcode-embedded-browser"],
    ["persist:zcode-coding-plan", "persist:lcode-coding-plan"],
  ] as const) {
    migrateDirCopyStyleSync(join(legacyUserData, "Partitions", legacyPartition), join(runtimeUserDataPath, "Partitions", partition));
  }
}
`;
    c = c.replace(
      'import { setDataBaseDir } from "@lcode/services/node";',
      'import { join } from "node:path";\nimport { app } from "electron";\nimport { migrateDirCopyStyleSync } from "@lcode/shared/node";\nimport { setDataBaseDir } from "@lcode/services/node";\nimport { runtimeApplicationName, runtimeUserDataPath } from "./desktopRuntimeEnv.js";',
    );
    fs.writeFileSync(p, c);
    console.log(`ok ${p}`);
  }

  const main = "packages/desktop/src/main/index.ts";
  let m = fs.readFileSync(main, "utf8");
  if (!m.includes("migrateDesktopIdentityDataSync()")) {
    m = m.replace(
      '  app.setPath("userData", runtimeUserDataPath);',
      '  // 品牌迁移：userData 与 Chromium 分区先于 Electron 使用它们完成迁移（幂等）。\n' +
        '  migrateDesktopIdentityDataSync();\n' +
        '  app.setPath("userData", runtimeUserDataPath);',
    );
    fs.writeFileSync(main, m);
    console.log(`ok ${main}`);
  }
}

// 3) CLI：home 根与工作区目录迁移（cwd 即工作区），在命令分发前完成
{
  const p = "apps/lcode-cli/packages/cli/src/main.ts";
  let c = fs.readFileSync(p, "utf8");
  if (!c.includes("migrateHomeBrandDataRootSync")) {
    c = c.replace(
      "async function main(): Promise<void> {",
      `async function main(): Promise<void> {
  // 品牌迁移（复制式、幂等）先于任何配置/会话库访问：~/.zcode → ~/.lcode，
  // 工作区 .zcode/.zcode-plugin → .lcode/.lcode-plugin（specs/brand-migration-lcode.md）。
  migrateHomeBrandDataRootSync(homedir());
  migrateWorkspaceBrandDirsSync(process.cwd());`,
    );
    if (!c.includes('from "node:os"')) {
      c = `import { homedir } from "node:os";\nimport { migrateHomeBrandDataRootSync, migrateWorkspaceBrandDirsSync } from "@lcode/shared/node";\n${c}`;
    }
    fs.writeFileSync(p, c);
    console.log(`ok ${p}`);
  }
}

// 4) server 两个入口：home 根迁移先于 config 目录使用
for (const [p, anchor] of [
  ["packages/server/src/entry-http.ts", "async function main(): Promise<void> {"],
  ["packages/server/src/entry-stdio.ts", "async function main() {"],
]) {
  let c = fs.readFileSync(p, "utf8");
  if (c.includes("migrateHomeBrandDataRootSync")) continue;
  if (!c.includes(anchor)) { console.log(`MISS anchor: ${p}`); continue; }
  c = c.replace(
    anchor,
    `${anchor}
  // 品牌迁移（复制式、幂等）先于 config/任务索引访问：~/.zcode → ~/.lcode。
  migrateHomeBrandDataRootSync(getDataBaseDir());`,
  );
  // 已从 @lcode/services/node 导入的行追加 getDataBaseDir
  c = c.replace(
    /import \{ ([^}]*?)getAppConfigDir/,
    (m0, g1) => `import { ${g1}getDataBaseDir, getAppConfigDir`,
  );
  if (!c.includes("@lcode/shared/node")) {
    c = `import { migrateHomeBrandDataRootSync } from "@lcode/shared/node";\n${c}`;
  }
  fs.writeFileSync(p, c);
  console.log(`ok ${p}`);
}
console.log("T2c done");
