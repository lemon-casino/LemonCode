// T2b：env 旧名兼容读 + 插件 env 双注入（批次 2，一次性）
// 依据 specs/brand-migration-lcode.md 兼容读取清单：用户/宿主可设 env 与插件子进程契约
// 采用「新名生效 + 旧名兼容」；既有用户脚本与旧插件在机械改名后才会静默失效。
import fs from "node:fs";

const EDITS = [
  // --- LCODE_DATA_BASE_DIR ← ZCODE_DATA_BASE_DIR ---
  ["packages/services/src/paths.ts", [
    [
      'const envDataBaseDir = process.env.LCODE_DATA_BASE_DIR?.trim() || null;',
      '// 品牌更名兼容：既有用户/宿主可能仍设置旧名 ZCODE_DATA_BASE_DIR（specs/brand-migration-lcode.md）。\n' +
      'const envDataBaseDir =\n' +
      '  process.env.LCODE_DATA_BASE_DIR?.trim() || process.env.ZCODE_DATA_BASE_DIR?.trim() || null;',
    ],
  ]],
  ["apps/lcode-cli/packages/adapters/src/auth/shared-credentials.ts", [
    [
      'const baseDir = options.baseDir ?? env[LCODE_DATA_BASE_DIR_ENV_KEY] ?? homedir();',
      'const baseDir =\n' +
      '      options.baseDir ??\n' +
      '      env[LCODE_DATA_BASE_DIR_ENV_KEY] ??\n' +
      '      // 旧名兼容：迁移窗口内既有环境仍可能使用 ZCODE_DATA_BASE_DIR。\n' +
      '      env["ZCODE_DATA_BASE_DIR"] ??\n' +
      '      homedir();',
    ],
  ]],
  ["apps/lcode-cli/packages/adapters/src/device/cli-device-mid.ts", [
    [
      'options.baseDir ?? env[LCODE_DATA_BASE_DIR_ENV_KEY]?.trim() ?? homedir();',
      'options.baseDir ??\n' +
      '      env[LCODE_DATA_BASE_DIR_ENV_KEY]?.trim() ??\n' +
      '      // 旧名兼容：迁移窗口内既有环境仍可能使用 ZCODE_DATA_BASE_DIR。\n' +
      '      env["ZCODE_DATA_BASE_DIR"]?.trim() ??\n' +
      '      homedir();',
    ],
  ]],
  // --- LCODE_HOME ← ZCODE_HOME ---
  ["apps/lcode-cli/packages/telemetry/src/bootstrap.ts", [
    [
      'existingInstallationId ?? (await resolveStandaloneDeviceMid(env.LCODE_HOME?.trim()));',
      '// 旧名兼容：LCODE_HOME 未设时回退旧 ZCODE_HOME（specs/brand-migration-lcode.md）。\n' +
      '    existingInstallationId ??\n' +
      '      (await resolveStandaloneDeviceMid(env.LCODE_HOME?.trim() || env.ZCODE_HOME?.trim()));',
    ],
  ]],
  ["packages/desktop/src/main/desktopRuntimeEnv.ts", [
    [
      'rawInheritedEnv.LCODE_HOME?.trim() || join(homedir(), ".lcode"),',
      '// 旧名兼容：LCODE_HOME 未设时回退旧 ZCODE_HOME。\n' +
      '              rawInheritedEnv.LCODE_HOME?.trim() ||\n' +
      '              rawInheritedEnv.ZCODE_HOME?.trim() ||\n' +
      '              join(homedir(), ".lcode"),',
    ],
  ]],
  ["packages/lcode-cua/broker-server.js", [
    [
      'join(env.LCODE_HOME?.trim() || homedir(), "computer-use"),',
      'join(env.LCODE_HOME?.trim() || env.ZCODE_HOME?.trim() || homedir(), "computer-use"),',
    ],
    [
      'const home = env.LCODE_HOME?.trim() || join(homedir(), ".lcode");',
      '// 旧名兼容：LCODE_HOME 未设时回退旧 ZCODE_HOME。\n' +
      '    const home = env.LCODE_HOME?.trim() || env.ZCODE_HOME?.trim() || join(homedir(), ".lcode");',
    ],
  ]],
  // --- LCODE_AGENT_SERVER_* ← ZCODE_AGENT_SERVER_*（用户/宿主覆盖 Agent 启动的公开配置面）---
  ["packages/services/src/lcode-agent/lcodeAgentProcessManager.ts", [
    [
      'const command = process.env.LCODE_AGENT_SERVER_COMMAND?.trim();',
      '// 旧名兼容：ZCODE_AGENT_SERVER_* 是既有宿主/用户覆盖面（specs/brand-migration-lcode.md）。\n' +
      '  const command =\n' +
      '    process.env.LCODE_AGENT_SERVER_COMMAND?.trim() ||\n' +
      '    process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();',
    ],
    [
      'args: parseArgsJson(process.env.LCODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],',
      'args:\n' +
      '        parseArgsJson(process.env.LCODE_AGENT_SERVER_ARGS_JSON) ??\n' +
      '        parseArgsJson(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) ??\n' +
      '        ["app-server", "--stdio"],',
    ],
    [
      'cwd: process.env.LCODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,',
      'cwd:\n' +
      '        process.env.LCODE_AGENT_SERVER_CWD?.trim() ||\n' +
      '        process.env.ZCODE_AGENT_SERVER_CWD?.trim() ||\n' +
        '        context.workspacePath,',
    ],
  ]],
];

for (const [file, pairs] of EDITS) {
  let c = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const [from, to] of pairs) {
    if (!c.includes(from)) { console.log(`MISS: ${file} :: ${from.slice(0, 60)}`); continue; }
    c = c.split(from).join(to);
    changed = true;
  }
  if (changed) { fs.writeFileSync(file, c); console.log(`ok ${file}`); }
}

// --- 插件子进程 env：新名生效 + 旧名兼容（旧插件读 ZCODE_*）---
const expansion = "apps/lcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts";
{
  let c = fs.readFileSync(expansion, "utf8");
  const pairs = [
    // 展开正则同时认 LCODE_/ZCODE_/CLAUDE_ 三族
    [
      'LCODE_PLUGIN_DATA|LCODE_PLUGIN_ROOT|LCODE_PROJECT_DIR|LCODE_SESSION_ID|LCODE_SKILL_DIR)\\}/gu;',
      'LCODE_PLUGIN_DATA|LCODE_PLUGIN_ROOT|LCODE_PROJECT_DIR|LCODE_SESSION_ID|LCODE_SKILL_DIR|' +
        'ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)\\}/gu;',
    ],
    [
      'set.LCODE_PROJECT_DIR = input.workingDirectory;',
      'set.LCODE_PROJECT_DIR = input.workingDirectory;\n' +
      '  // 旧名兼容：已文档化的 ZCODE_* 插件变量继续注入同一取值（旧插件契约）。\n' +
      '  set.ZCODE_PROJECT_DIR = input.workingDirectory;',
    ],
    [
      'set.LCODE_SESSION_ID = input.sessionId;',
      'set.LCODE_SESSION_ID = input.sessionId;\n' +
      '    set.ZCODE_SESSION_ID = input.sessionId;',
    ],
    [
      'set.LCODE_PLUGIN_DATA = input.plugin.dataPath;',
      'set.LCODE_PLUGIN_DATA = input.plugin.dataPath;\n' +
      '    set.ZCODE_PLUGIN_DATA = input.plugin.dataPath;',
    ],
    [
      'set.LCODE_PLUGIN_ROOT = input.plugin.rootPath;',
      'set.LCODE_PLUGIN_ROOT = input.plugin.rootPath;\n' +
      '    set.ZCODE_PLUGIN_ROOT = input.plugin.rootPath;',
    ],
    [
      'if (name === "CLAUDE_SKILL_DIR" || name === "LCODE_SKILL_DIR") {',
      'if (name === "CLAUDE_SKILL_DIR" || name === "LCODE_SKILL_DIR" || name === "ZCODE_SKILL_DIR") {',
    ],
    [
      'name === "LCODE_SESSION_ID")',
      'name === "LCODE_SESSION_ID" ||\n        name === "ZCODE_SESSION_ID")',
    ],
    [
      'name === "LCODE_PLUGIN_DATA" ||\n        name === "LCODE_PLUGIN_ROOT")',
      'name === "LCODE_PLUGIN_DATA" ||\n        name === "LCODE_PLUGIN_ROOT" ||\n        name === "ZCODE_PLUGIN_DATA" ||\n        name === "ZCODE_PLUGIN_ROOT")',
    ],
  ];
  let changed = false;
  for (const [from, to] of pairs) {
    if (!c.includes(from)) { console.log(`MISS: ${expansion} :: ${from.slice(0, 50)}`); continue; }
    c = c.split(from).join(to);
    changed = true;
  }
  if (changed) { fs.writeFileSync(expansion, c); console.log(`ok ${expansion}`); }
}

// node-repl 注入端：子进程 env 同步注入旧名
const repl = "apps/lcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts";
{
  let c = fs.readFileSync(repl, "utf8");
  const from = '...(browserUsePackage ? { LCODE_PLUGIN_ROOT: browserUsePackage.rootPath } : {}),';
  if (!c.includes(from)) {
    console.log(`MISS: ${repl}`);
  } else {
    c = c.replace(
      from,
      '// 旧名兼容：旧插件仍读 ZCODE_PLUGIN_ROOT，双名注入同一取值。\n' +
        '      ...(browserUsePackage\n' +
        '        ? { LCODE_PLUGIN_ROOT: browserUsePackage.rootPath, ZCODE_PLUGIN_ROOT: browserUsePackage.rootPath }\n' +
        '        : {}),',
    );
    fs.writeFileSync(repl, c);
    console.log(`ok ${repl}`);
  }
}
console.log("T2b done");
