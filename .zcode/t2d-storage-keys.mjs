// T2d：存储键兼容读 + 凭据双写 + 迁移时旧键别名补写（批次 2，一次性）
import fs from "node:fs";

// A. 迁移模块：复制完成后对目标副本做旧键别名补写（幂等、源目录不动）
{
  const p = "packages/shared/src/node/brandDataMigration.ts";
  let c = fs.readFileSync(p, "utf8");
  if (!c.includes("aliasJsonKeysInPlace")) {
    c = c.replace(
      `/** 用户级数据根迁移（同步）：~/.zcode → ~/.lcode。幂等。 */
export function migrateHomeBrandDataRootSync(homeDir: string): BrandDirMigrationOutcome {
  const outcome = migrateDirCopyStyleSync(join(homeDir, LEGACY_HOME_DATA_DIR), join(homeDir, HOME_DATA_DIR));`,
      `/**
 * 对迁移副本内的 JSON 文件做旧品牌键 → 新品牌键的别名补写（add-if-absent，幂等）。
 * 只改写目标副本；凭据/设置读取端按新键取值，老用户数据因此无缝可见。
 * 尽力而为：单个文件失败不影响迁移结果（源目录仍原样保留，可重登录恢复）。
 */
function aliasJsonKeysInPlace(filePath: string, aliases: readonly [string, string][]): void {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    let changed = false;
    for (const [legacyKey, newKey] of aliases) {
      if (legacyKey in record && !(newKey in record)) {
        record[newKey] = record[legacyKey];
        changed = true;
      }
    }
    if (changed) writeFileSync(filePath, JSON.stringify(record, null, 2));
  } catch {
    // 非致命：别名补写失败时用户最多需要重新登录一次；源目录数据不受影响。
  }
}

/** 用户级数据根迁移（同步）：~/.zcode → ~/.lcode。幂等。 */
export function migrateHomeBrandDataRootSync(homeDir: string): BrandDirMigrationOutcome {
  const outcome = migrateDirCopyStyleSync(join(homeDir, LEGACY_HOME_DATA_DIR), join(homeDir, HOME_DATA_DIR));`,
    );
    c = c.replace(
      `    migrateDirCopyStyleSync(join(workspacePath, LEGACY_WORKSPACE_PLUGIN_DIR), join(workspacePath, WORKSPACE_PLUGIN_DIR)),
    ],
  };
}

/** 把 sourceDir 复制式迁移到 targetDir（异步包装；语义与同步变体一致）。 */`,
      `    migrateDirCopyStyleSync(join(workspacePath, LEGACY_WORKSPACE_PLUGIN_DIR), join(workspacePath, WORKSPACE_PLUGIN_DIR)),
    ],
  };
}

/** 把 sourceDir 复制式迁移到 targetDir（异步包装；语义与同步变体一致）。 */`,
    );
    // 在 home root 迁移的 return 之前插入别名补写
    c = c.replace(
      `export function migrateHomeBrandDataRootSync(homeDir: string): BrandDirMigrationOutcome {
  const outcome = migrateDirCopyStyleSync(join(homeDir, LEGACY_HOME_DATA_DIR), join(homeDir, HOME_DATA_DIR));
  return outcome;
}`,
      `export function migrateHomeBrandDataRootSync(homeDir: string): BrandDirMigrationOutcome {
  const outcome = migrateDirCopyStyleSync(join(homeDir, LEGACY_HOME_DATA_DIR), join(homeDir, HOME_DATA_DIR));
  if (outcome.status === "migrated") {
    // 旧键别名补写：凭据与设置读取端按新键取值（specs/brand-migration-lcode.md 兼容读取清单）。
    aliasJsonKeysInPlace(join(homeDir, HOME_DATA_DIR, "v2", "credentials.json"), [
      ["zcodejwttoken", "lcodejwttoken"],
    ] as const);
    aliasJsonKeysInPlace(join(homeDir, HOME_DATA_DIR, "v2", "setting.json"), [
      ["zcodeEndpointOrigin", "lcodeEndpointOrigin"],
    ] as const);
  }
  return outcome;
}`,
    );
    // 同步实现需要 readFileSync/writeFileSync
    c = c.replace(
      'import { cpSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";',
      'import { cpSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";',
    );
    fs.writeFileSync(p, c);
    console.log(`ok ${p}`);
  }
}

// B. 凭据双写：新登录同时写旧键名，旧版本 CLI 共享同一凭据文件期间不掉登录
{
  const p = "packages/services/src/model-provider/accountProviderCredentialStore.ts";
  let c = fs.readFileSync(p, "utf8");
  if (!c.includes("LEGACY_BRAND_CREDENTIAL_KEY")) {
    c = c.replace(
      `      await options.credentialService.save(key, normalized);
    },`,
      `      await options.credentialService.save(key, normalized);
      // 品牌更名双写：旧版本 CLI 共享同一凭据文件，按旧键名保留别名（specs/brand-migration-lcode.md）。
      const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[key];
      if (legacyAlias) {
        await options.credentialService.save(legacyAlias, normalized).catch(() => undefined);
      }
    },`,
    );
    c = c.replace(
      `    async deleteApiKey(credentialKey: string) {`,
      `    async deleteApiKey(credentialKey: string) {
      const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[requireCredentialKey(credentialKey)];
      if (legacyAlias) {
        await options.credentialService.delete(legacyAlias).catch(() => undefined);
      }`,
    );
    // 常量 + delete 签名适配：deleteApiKey 可能无参注解，先探测
    if (!c.includes("const LEGACY_BRAND_CREDENTIAL_KEY_ALIASES")) {
      c = c.replace(
        "function requireCredentialKey(value: string): string {",
        `// 旧品牌键别名：双写窗口内旧版本客户端仍按旧键名读取。
const LEGACY_BRAND_CREDENTIAL_KEY_ALIASES: Record<string, string> = {
  lcodejwttoken: "zcodejwttoken",
};

function requireCredentialKey(value: string): string {`,
      );
    }
    fs.writeFileSync(p, c);
    console.log(`ok ${p}`);
  }
  {
    const p2 = "packages/services/src/model-provider/providerProvisioningTarget.ts";
    let c2 = fs.readFileSync(p2, "utf8");
    if (!c2.includes("LEGACY_BRAND_CREDENTIAL_KEY_ALIASES")) {
      c2 = c2.replace(
        `            if (value === undefined) await options.credentialService.delete(key);
            else await options.credentialService.save(key, value);`,
        `            if (value === undefined) {
              await options.credentialService.delete(key);
              const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[key];
              if (legacyAlias) await options.credentialService.delete(legacyAlias).catch(() => undefined);
            } else {
              await options.credentialService.save(key, value);
              // 品牌更名双写：旧版本客户端按旧键名读取（specs/brand-migration-lcode.md）。
              const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[key];
              if (legacyAlias) await options.credentialService.save(legacyAlias, value).catch(() => undefined);
            }`,
      );
      c2 = c2.replace(
        /^(import[^\n]*\n)/,
        `$1// 旧品牌键别名：双写窗口内旧版本客户端仍按旧键名读取。\nconst LEGACY_BRAND_CREDENTIAL_KEY_ALIASES: Record<string, string> = {\n  lcodejwttoken: "zcodejwttoken",\n};\n`,
      );
      fs.writeFileSync(p2, c2);
      console.log(`ok ${p2}`);
    }
  }
}

// C. 主题/语言双读
{
  const p = "packages/ui/src/store/index.ts";
  let c = fs.readFileSync(p, "utf8");
  c = c.split('readSafeLocalStorage("lcode-theme")').join('readSafeLocalStorage("lcode-theme") ?? readSafeLocalStorage("zcode-theme")');
  c = c.split('readSafeLocalStorage("lcode-locale")').join('readSafeLocalStorage("lcode-locale") ?? readSafeLocalStorage("zcode-locale")');
  fs.writeFileSync(p, c);
  console.log(`ok ${p}`);
  const p2 = "packages/desktop/src/renderer/src/main.tsx";
  let c2 = fs.readFileSync(p2, "utf8");
  c2 = c2.replace(
    'const saved = localStorage.getItem("lcode-theme") || "zai-dark";',
    '// 旧键兼容读：老用户主题偏好存于 zcode-theme（specs/brand-migration-lcode.md）。\n' +
      '  const saved =\n' +
      '    localStorage.getItem("lcode-theme") || localStorage.getItem("zcode-theme") || "zai-dark";',
  );
  fs.writeFileSync(p2, c2);
  console.log(`ok ${p2}`);
  const p3 = "packages/web/index.html";
  let c3 = fs.readFileSync(p3, "utf8");
  c3 = c3.replace(
    'const saved = localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;',
    'const saved =\n' +
      '            localStorage.getItem(STORAGE_KEY) ||\n' +
      '            // 旧键兼容读：老用户主题偏好存于 zcode-theme。\n' +
      '            localStorage.getItem("zcode-theme") ||\n' +
      '            DEFAULT_THEME;',
  );
  fs.writeFileSync(p3, c3);
  console.log(`ok ${p3}`);
}

// D. 配对凭据/重连预算双读（sessionStorage，旧键在同一 origin）
{
  const p = "packages/web/src/remote/pairingCredentialStore.ts";
  let c = fs.readFileSync(p, "utf8");
  c = c.replace(
    'const raw = window.sessionStorage.getItem(STORAGE_KEY);',
    '// 旧键兼容读：老会话凭据存于 zcode:remote-pairing:device。\n' +
      '    const raw =\n' +
      '      window.sessionStorage.getItem(STORAGE_KEY) ||\n' +
      '      window.sessionStorage.getItem("zcode:remote-pairing:device");',
  );
  fs.writeFileSync(p, c);
  console.log(`ok ${p}`);
  const p2 = "packages/web/src/remote/mirrorReconnect.ts";
  let c2 = fs.readFileSync(p2, "utf8");
  c2 = c2.replace(
    'const raw = window.sessionStorage.getItem(MIRROR_RELOAD_BUDGET_KEY);',
    '// 旧键兼容读：老会话预算存于 zcode:remote-pairing:reconnect-reloads。\n' +
      '    const raw =\n' +
      '      window.sessionStorage.getItem(MIRROR_RELOAD_BUDGET_KEY) ||\n' +
      '      window.sessionStorage.getItem("zcode:remote-pairing:reconnect-reloads");',
  );
  fs.writeFileSync(p2, c2);
  console.log(`ok ${p2}`);
}

// E. 工具元数据旧键回退（旧会话数据里 _meta/data 下的键是 zcode）
{
  const p = "packages/ui/src/lib/lcodeUiError.ts";
  let c = fs.readFileSync(p, "utf8");
  const lines = c.split("\n");
  const out = [];
  for (const line of lines) {
    out.push(line);
    if (line.includes('["data", "lcode",')) {
      out.push(line.replace('"lcode"', '"zcode"').replace(/,\s*$/, ","));
    }
  }
  fs.writeFileSync(p, `${out.join("\n")}`);
  console.log(`ok ${p}`);
  const p2 = "packages/ui/src/ToolCallBlocks/renderers/agentHelpers.ts";
  let c2 = fs.readFileSync(p2, "utf8");
  c2 = c2.replace(
    'readStringFromNestedRecord(toolCall.raw, ["_meta", "lcode", "color"]) ??',
    'readStringFromNestedRecord(toolCall.raw, ["_meta", "lcode", "color"]) ??\n' +
      '    // 旧会话数据兼容读：旧版本 agent 写的是 _meta.zcode。\n' +
      '    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "color"]) ??',
  );
  c2 = c2.replace(
    'readStringFromNestedRecord(toolCall.raw, ["_meta", "lcode", "taskNotification", "result"]) ??\n    readStringFromNestedRecord(toolCall.raw, ["_meta", "lcode", "taskNotification", "summary"]);',
    'readStringFromNestedRecord(toolCall.raw, ["_meta", "lcode", "taskNotification", "result"]) ??\n' +
      '    readStringFromNestedRecord(toolCall.raw, ["_meta", "lcode", "taskNotification", "summary"]) ??\n' +
      '    // 旧会话数据兼容读：旧版本 agent 写的是 _meta.zcode。\n' +
      '    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "taskNotification", "result"]) ??\n' +
      '    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "taskNotification", "summary"]);',
  );
  fs.writeFileSync(p2, c2);
  console.log(`ok ${p2}`);
  const p3 = "packages/ui/src/lib/toolIdentity.ts";
  let c3 = fs.readFileSync(p3, "utf8");
  c3 = c3.replace(
    'lcode: readNestedString(raw, ["_meta", "lcode", "toolName"]),',
    'lcode:\n' +
      '      readNestedString(raw, ["_meta", "lcode", "toolName"]) ??\n' +
      '      // 旧会话数据兼容读：旧版本 agent 写的是 _meta.zcode。\n' +
      '      readNestedString(raw, ["_meta", "zcode", "toolName"]),',
  );
  fs.writeFileSync(p3, c3);
  console.log(`ok ${p3}`);
}
console.log("T2d done");
