# 内置后端模块路径的打包兼容

## 已确认问题与产品规则

`server build:remote` 输出 CommonJS，既有 banner/define 支持 import.meta.url 与 dirname。
runtime-environment 的 bundledBackend 使用 import.meta.filename，esbuild 报 empty-import-meta。
默认模块路径分支会得到 undefined，并在 replaceAll 处抛错。
显式 resourcesPath/serverRuntimeRoot 提前返回的分支不能代替默认分支验收。

- 默认模块位置从 `fileURLToPath(import.meta.url)` 取得，复用现有远程 CJS URL 兼容合同。
- 保留调用方提供的 modulePath、resourcesPath、serverRuntimeRoot 和 developmentToolsRoot 的优先级。
- 保留平台/架构、绝对资源根校验、app.asar 邻接工具目录、开发工具目标目录及独立 server 邻接目录。
- 不改远程服务的 CJS 格式，不从项目 cwd、PATH 或任意 binary 环境变量寻找 mise。
- 不隐藏构建警告，不跳过后端完整性校验，不增加新的资源下载或状态所有者。

## 所有者与边界

runtime-environment/adapters/bundledBackend 是纯路径定位器；执行 Host 组合根提供显式资源目录。
server 的既有构建入口拥有 import.meta.url 的 CJS 兼容映射。本次不新增公开接口、协议或写入路径。
定位发生在环境后端创建之前，不改 workspaceIdentity、remoteSessionId、lease、命令准入或同步顺序。

## 验收

1. 先用既有 CJS URL/dirname 兼容配置编译定位器并加载，复现默认定位路径失败。
2. 修复后 ESM 与 CJS 产物均能无 modulePath 注入地定位其邻接 tools/mise/bin，编译不产生 empty-import-meta。
3. 临时产物目录包含空格、百分号和中文，验证 URL 解码正确。
4. 显式根、开发态、app.asar 与非法平台/路径的既有测试仍通过。
5. 根 typecheck、lint、changed architecture 与改动文件格式检查通过。
6. 只构建定位器夹具，不构建或覆盖用户正在生成的 server / 桌面产物。

## 验证记录（2026-10-13）

先加载修复前的 CJS 夹具，实际复现 `Cannot read properties of undefined (reading 'replaceAll')`；
修正后定位器测试 6 / 6 通过，ESM/CJS 构建 warnings 均为空。产物实际运行于 Node 24.21.0，
esbuild target 为既有 server 的 node22；没有把 Windows 上的路径夹具称为 Linux 实机验证。

根 typecheck、lint、changed architecture 通过，架构 baseline 0、new 0；四个改动文件格式检查通过。
所属模块为 managed runtime-environment（adapters 路径定位），生产代码净增 3 行，测试净增 45 行，
不计本次 spec、合同说明和此前改动。未增加依赖边、IO、状态 owner 或公开方法。
未构建完整 server / 桌面安装包；用户正在构建的 dist 未被本次测试覆盖。
