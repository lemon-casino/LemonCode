# Windows 命令参数与重定向边界

## 问题与证据

2026-10-02 在工作区发现以 JavaScript 片段命名的空文件。历史命令及隔离进程复现确认了两条独立路径：

- `scripts/mise-run.mjs` 在 Windows 上对所有命令使用 `spawn(command, args, { shell: true })`。Node 将 argv 用空格拼接后交给 CMD，`=>`、`>=` 等代码字符被解释为重定向；历史 `pnpm exec tsx -e` 命令生成了 `{`。
- 本机 Volta 2.0.2 的 Node shim 在启动真正的 Node 之前插入 CMD。带内嵌引号的代码参数经过这条外部链路时也被截断。直接调用真实 Node 或将代码交给 stdin 可避免该问题；LCode 的 Git Bash 命令解析和 cwd 包装在复现中没有改写原命令。

## 产品规则与范围

1. 仓库的 argv 执行入口将命令与参数视为数据，不把参数当作 Shell 程序。Windows 原生可执行文件及 macOS/Linux 命令直接以 `shell: false` 启动。
2. Windows `.cmd`、`.bat` 及现有 bare `pnpm` / `npm` 兼容入口必须显式调用 CMD，关闭 AutoRun 和 delayed expansion，对命令路径及参数分别转义，保留 CMD 启动与 batch `%*` 转发两次解析后的参数边界。不再依赖 Node 的 `shell: true` 参数拼接。
3. 空参数、空格、中文、双引号、引号前和结尾的反斜杠、`=>`、`>=`、`&|<>^()`、`%NAME%` 和 `!NAME!` 必须原样到达最终可执行程序。真实重定向只能出现在调用方显式选择的 Shell 程序里，不能由普通 argv 暗中产生。
4. CMD/batch 入口的命令或参数包含换行时，在启动前明确拒绝，提示改用脚本文件或 stdin；不尝试猜测、截断或拼接成多条命令。原生 Node 的多行参数不受此限制。
5. `mise-run` 保留原 cwd、stdio、退出码/信号和 `withPinnedNodePath` 的 runtime 选择规则；调用 `node` / `node.exe` 时直接使用启动器的 `process.execPath`，不重新进入 PATH 中的外部 Node shim。现有 `pnpm.cmd` 包上下文语义不变。
6. Bash 工具描述补充 Windows 命令指引：复杂 JavaScript 不通过 `node -e` / `tsx -e` 跨包装器传递；Git Bash 下使用带引号分隔符的 heredoc 将代码送至 Node stdin，CMD 下使用脚本文件。不得用 browser/computer Node REPL 执行非浏览器任务。此规则是模型使用指导，不声称能拦截全部任意 Shell 命令。
7. 不自动改写用户 Shell 程序中的 `>`、不更换 Shell、不修改 Volta、系统 PATH 或用户配置。不自动删除历史异常文件，也不将其加入忽略列表。

## 唯一所有者与调用顺序

```text
mise-run / dev-desktop-env / 同步构建脚本
    → scripts/spawn-command.mjs：argv 到 OS 启动参数的唯一编码入口
        ├─ 原生程序：spawn(file, argv, shell=false)
        └─ Windows batch：CMD（禁用 AutoRun/延迟展开）→ batch → 原始 argv
    → 调用方沿用现有 stdout/stderr、退出码和信号处理

Bash 模型指引 → 已选 Shell → stdin / 脚本文件 → 外部 runtime
```

- `scripts/` 是根工具链脚本，不新增业务模块或跨包依赖；复用已有 `spawn-command.mjs`，异步入口和两个同步入口共用参数编码。
- Bash 描述及其测试属于现有 `lcode-cli` 模块的 core 工具层；不修改 execution adapter、权限准入、会话状态或协议。
- 没有新增持久状态、队列或重试。失败不自动重跑命令，防止重复副作用。
- 已使用固定参数调用 `resolveSpawnRuntimeOptions` 的其他构建入口不在本轮迁移范围；不声称已经审计所有外部或第三方 batch 脚本。

## 验收

1. 先以真实临时目录、Node 参数报告器和 `.cmd` / `.bat` shim 复现旧行为失败，再验证修复后 argv 逐项相等，目录无额外文件。
2. 覆盖原生可执行文件与脚本路径含空格、复杂代码、多行原生参数、退出码、缺失程序、CMD 换行拒绝及异步/同步入口。
3. `mise-run` 的实际子进程测试包含按磁盘解析真实 pnpm 入口的 `pnpm exec` 链路及 stdin；不连接网络、不启动应用、不修改仓库业务文件。
4. Bash 描述回归验证 Windows、stdin/heredoc、CMD 脚本文件指引仍在，并保留已有后台任务与 Git 规则。
5. 执行新增进程回归、相关 Bash 工具回归、根 `pnpm typecheck`、`pnpm lint`、CLI core 类型/Lint、`pnpm architecture:check --changed` 和改动文件格式检查。真实平台验证在 Windows，macOS/Linux 未运行时明确说明。
