# GitHub Actions 桌面全平台发布

## 产品规则

1. 桌面发行版本只有根目录 `package.json` 的 `version` 一个所有者。首次发布为
   `3.14.2`；CLI 子项目的独立版本不随桌面版本改写。正式 tag 使用 `v<version>`。
2. 每次推送 `main` 构建六种本机目标：macOS/Windows/Linux 的 x64 与 arm64。
   分支构建只保留 Actions 构建产物；`v*` tag 的构建必须先验证 tag 和
   `package.json` 版本完全一致，禁止把旧源码打成新版本。
3. 发行矩阵复用 `pnpm bundle:desktop -- --os <os> --arch <arch>`。所有 job 使用
   `mise.toml` 指定的 Node/pnpm 版本，以 `pnpm install --frozen-lockfile` 安装依赖，
   保持 production 产品身份，并跳过不属于桌面安装包的远端预构建。
4. 每个构建只上传目标架构、目标版本的安装包；缺任何目标文件立即失败。
   仅当六个目标全部成功时创建/更新 GitHub Release 草稿；公开发布还需通过
   `readVerifiedNotices({ requireComplete: true })`。已知待复核项不得被基础校验掩盖。
   Linux 文件名由 electron-builder 各安装格式的原生架构命名决定：x64 的
   AppImage/RPM 为 `x86_64`、deb 为 `amd64`、pacman 为 `x64`；arm64 的
   AppImage/deb 为 `arm64`、RPM/pacman 为 `aarch64`。收集脚本按格式精确匹配
   `ZCode-<version>-linux-<native-arch>.<extension>`，不得将错误架构或旧版本
   的文件视为目标产物；其他平台保持现有 `<arch>` 命名。
5. Actions 的发行上传权限只给 Release job；构建 job 仅可读。发布使用 tag 自带的
   `GITHUB_TOKEN`，不借用开发者本地凭据。tag 推送由维护者在版本文件、许可证清单
   和验证提交后执行，不由 `GITHUB_TOKEN` 在工作流内自推 tag。
6. 无 Apple 签名和公证凭据时，macOS 构建必须标明未签名；不得宣称 Gatekeeper
   可直接通过。保持 electron-builder 原有 generic 更新服务配置，GitHub Release
   是下载安装包的分发面，不冒充应用内自动更新源。

## 所有者与事件顺序

`package.json` 拥有版本，Git tag 只是不可变的版本声明；现有 build-metadata 和
electron-builder 从它读取产物版本。GitHub Actions matrix 只持有当前 job 的短暂构建
文件；仓库发布脚本拥有安装包格式到原生架构后缀的匹配规则，Release job 是唯一上传
公开 Release 的路径。构建失败不发布，重试仅覆盖同一
tag 的已验证资产，不创建另一个版本。

```mermaid
sequenceDiagram
  participant Maintainer as 维护者
  participant Git as Git tag
  participant Matrix as 六个平台构建
  participant Release as GitHub Release
  Maintainer->>Git: 推送 v3.14.2
  Git->>Matrix: checkout tag，核对 package.json.version
  Matrix->>Matrix: 原生构建 + 校验版本及架构 + 上传临时 artifact
  Matrix-->>Release: 全部成功后下载六组安装包
  Release->>Release: 上传同名 tag 的资产，发布 Release
```

## 验收

- `v3.14.2` 通过门禁，`v3.14.3` 与版本 `3.14.2` 不一致时失败。
- 6 个 target 各自只接收自己的安装包；缺失、错架构、错版本或重复文件名都失败。
- Linux 两种架构的四种格式分别按真实生成的后缀收集，x64 不接收 arm64/aarch64，
  arm64 不接收 x64/x86_64/amd64；既有非 Linux 命名与版本不改变。
- `main` 构建不创建 Release；任一目标失败或严格许可校验不通过时 tag 不创建公开 Release。
- 本地构建脚本版本元数据、安装包文件名、Release tag 一致。
