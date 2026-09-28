// T2e：凭据双写补齐（CRLF 感知）+ cookie 双读 + hook 配置旧文件名探测（一次性）
import fs from "node:fs";

/** CRLF 感知的包含替换：anchor 与 replacement 均以 \n 书写，按文件行尾风格落盘。 */
function replaceBlock(file, anchorLines, replacementLines) {
  let c = fs.readFileSync(file, "utf8");
  const crlf = c.includes("\r\n");
  const norm = (s) => (crlf ? s.replaceAll("\n", "\r\n") : s);
  const anchor = norm(anchorLines.join("\n"));
  const replacement = norm(replacementLines.join("\n"));
  if (!c.includes(anchor)) {
    console.log(`MISS: ${file} :: ${anchorLines[0].slice(0, 50)}`);
    return false;
  }
  c = c.split(anchor).join(replacement);
  fs.writeFileSync(file, c);
  console.log(`ok ${file} :: ${anchorLines[0].slice(0, 40)}`);
  return true;
}

// 1) accountProviderCredentialStore：save/delete 双写旧键
{
  const p = "packages/services/src/model-provider/accountProviderCredentialStore.ts";
  replaceBlock(p,
    ["      await options.credentialService.save(key, normalized);", "    },"],
    [
      "      await options.credentialService.save(key, normalized);",
      "      // 品牌更名双写：旧版本 CLI 共享同一凭据文件，按旧键名保留别名（specs/brand-migration-lcode.md）。",
      "      const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[key];",
      "      if (legacyAlias) {",
      "        await options.credentialService.save(legacyAlias, normalized).catch(() => undefined);",
      "      }",
      "    },",
    ],
  );
  replaceBlock(p,
    ["    async deleteApiKey(credentialKey) {", "      await options.credentialService.delete(requireCredentialKey(credentialKey));"],
    [
      "    async deleteApiKey(credentialKey) {",
      "      const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[requireCredentialKey(credentialKey)];",
      "      if (legacyAlias) {",
      "        await options.credentialService.delete(legacyAlias).catch(() => undefined);",
      "      }",
      "      await options.credentialService.delete(requireCredentialKey(credentialKey));",
    ],
  );
}

// 2) providerProvisioningTarget：凭据应用循环内双写/双删
{
  const p = "packages/services/src/model-provider/providerProvisioningTarget.ts";
  replaceBlock(p,
    [
      "            if (value === undefined) await options.credentialService.delete(key);",
      "            else await options.credentialService.save(key, value);",
    ],
    [
      "            if (value === undefined) {",
      "              await options.credentialService.delete(key);",
      "              // 品牌更名双写：旧版本客户端按旧键名读取（specs/brand-migration-lcode.md）。",
      "              const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[key];",
      "              if (legacyAlias) await options.credentialService.delete(legacyAlias).catch(() => undefined);",
      "            } else {",
      "              await options.credentialService.save(key, value);",
      "              const legacyAlias = LEGACY_BRAND_CREDENTIAL_KEY_ALIASES[key];",
      "              if (legacyAlias) await options.credentialService.save(legacyAlias, value).catch(() => undefined);",
      "            }",
    ],
  );
}

// 3) server：Web 鉴权 cookie 双读（旧会话不掉登录）
{
  const p = "packages/server/src/http.ts";
  replaceBlock(p,
    [
      'const lcodeLiteTokenCookieName = "lcode_lite_token";',
    ],
    [
      'const lcodeLiteTokenCookieName = "lcode_lite_token";',
      '// 品牌更名过渡：旧 Web 会话的 HttpOnly cookie 仍是旧名，双读避免全员掉登录（specs/brand-migration-lcode.md）。',
      'const legacyZcodeLiteTokenCookieName = "zcode_lite_token";',
    ],
  );
  replaceBlock(p,
    [
      "  return parseCookieHeader(c.req.header(\"cookie\")).get(lcodeLiteTokenCookieName) === token;",
    ],
    [
      "  const cookies = parseCookieHeader(c.req.header(\"cookie\"));",
      "  return (",
      "    cookies.get(lcodeLiteTokenCookieName) === token ||",
      "    cookies.get(legacyZcodeLiteTokenCookieName) === token",
      "  );",
    ],
  );
}

// 4) workspace hook 配置：候选文件名加入旧名探测；kind/baseDir/editable 识别旧名
{
  const p = "packages/shared/src/workspace-hook-config.ts";
  replaceBlock(p,
    [
      "  return directories.flatMap((directory) => [",
      '    join(directory, "lcode.json"),',
      '    join(directory, ".lcode", "config.json"),',
      "  ]);",
    ],
    [
      "  return directories.flatMap((directory) => [",
      '    join(directory, "lcode.json"),',
      '    join(directory, ".lcode", "config.json"),',
      "    // 旧名兼容探测：老工作区的配置文件仍叫 zcode.json / .zcode/config.json，",
      "    // 命中后按对应新 kind 处理（specs/brand-migration-lcode.md）。",
      '    join(directory, "zcode.json"),',
      '    join(directory, ".zcode", "config.json"),',
      "  ]);",
    ],
  );
  replaceBlock(p,
    [
      "    baseDir: basename(configDirectory) === \".lcode\" ? dirname(configDirectory) : configDirectory,",
      "    discoveryOrder: input.discoveryOrder,",
      "    configFileKind: explicitProjectConfig",
      "      ? \"explicit\"",
      '      : basename(canonicalPath) === "lcode.json"',
      '        ? "lcode.json"',
      '        : ".lcode/config.json",',
      "    explicitProjectConfig,",
      "    editable:",
      '      !explicitProjectConfig &&',
      '      canonicalPath === resolve(input.workingDirectory, ".lcode", "config.json"),',
    ],
    [
      '    baseDir:',
      '      basename(configDirectory) === ".lcode" || basename(configDirectory) === ".zcode"',
      "        ? dirname(configDirectory)",
      "        : configDirectory,",
      "    discoveryOrder: input.discoveryOrder,",
      "    configFileKind: explicitProjectConfig",
      "      ? \"explicit\"",
      '      : basename(canonicalPath) === "lcode.json" || basename(canonicalPath) === "zcode.json"',
      '        ? "lcode.json"',
      '        : ".lcode/config.json",',
      "    explicitProjectConfig,",
      "    editable:",
      "      !explicitProjectConfig &&",
      '      (canonicalPath === resolve(input.workingDirectory, ".lcode", "config.json") ||',
      '        canonicalPath === resolve(input.workingDirectory, ".zcode", "config.json")),',
    ],
  );
}
console.log("T2e done");
