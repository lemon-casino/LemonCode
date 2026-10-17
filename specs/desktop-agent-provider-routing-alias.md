# Desktop Agent 的 provider-routing 子入口解析

## 已确认原因与规则

2026-10-16 用户实际构建在 `build:desktop-agent` 失败。`@lcode/shared/provider-routing`
已经是 shared 的公开入口，文件存在；CLI 的 esbuild alias 仅声明通用 `@lcode/shared`
和其它子入口，将该导入按前缀改写成 `src/index.ts/provider-routing`，导致六处导入的解析失败。
后续 prepare:agent-bundle、runtime-assets 和 bundle 错误是同一失败的上层传播。

- 在现有 `resolveBuildAliases` 中精确映射该公开子入口，Desktop Agent、普通 CLI 与 SEA
  继续复用同一构建配置。不复制 provider schema，也不改业务 import 来绕过包边界。
- shared 继续拥有 schema；CLI build 脚本仅拥有源码入口定位，不新增状态或运行时接口。
- 不改变版本、远端资源模式、安装路径或既有外置模块配置。
- 类型检查与 Lint 不验证 esbuild alias，必须补实际 bundle 解析和执行的回归。

## 验收与执行边界

1. 使用生产 `resolveBuildAliases` 在内存打包路由公开入口，修复前重现相同解析错误。
2. 修复后实际执行 schema：合法策略通过，非法策略和重复路由拒绝；轻量入口不引入 shared 总入口。
3. 既有网络代理、provider network 与 model-catalog 构建回归通过。
4. 使用实际 CLI main 入口和生产 alias、Zod 去重、external 配置内存打包，验证完整 Agent 图；
   `write: false`，不覆盖 dist、不准备安装资源、不运行安装包或模型 Runtime。
5. 执行根类型、Lint、CLI 类型/Lint、架构和改动格式检查，报告真实结果。

用户此前要求暂停安装包、稍后自行构建；本轮只修构建配置及验证，不启动桌面打包或安装。

## 实际验证（2026-10-16）

- 修复前新增的路由子入口回归实际失败，错误与用户日志中的 `index.ts/provider-routing` 一致。
- 修复后与原 Agent 同步回归合计 10 / 10 通过；证据为
  `.artifacts/desktop-agent-routing-alias-after.log`。
- 真实 Agent main 入口内存打包成功，3,246 个输入、16,118,214 字节输出、无 warnings；
  原 `dist/lcode.cjs` 的 mtime/size 未改变。详见
  `.artifacts/desktop-agent-routing-alias-memory-bundle.json`。
- 根 `pnpm typecheck`、`pnpm lint` 与 CLI 类型/Lint 通过；架构 violations / baseline / new 均为 0。
- 生产映射新增 5 行，邻近格式调整净增 3 行，回归净增 29 行；所属 legacy lcode-cli 与构建测试脚本，
  无新增业务状态 owner、依赖边或协议。未生成安装包、未安装、未提交或推送。
