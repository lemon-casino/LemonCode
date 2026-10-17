# 内置启动动画与壁纸

这些文件默认进入 Windows、macOS、Linux 桌面构建和安装包，无需环境开关或在线下载。

- `baili.mp4`：基于 `baili-codex` 原始 Canvas 工程重绘的 LCode 版本，主标题 `LCode`、左上角 `OPENAI / LCode`；保留原人物动态、文字特效、配乐及 3840×2160 / 60 fps / 16 秒规格。
- `aemeath-artwork.jpg`、`aemeath-contours.json`：来自 `codex-startup-animation`，由 LCode 可编辑 Canvas 模板使用，不包含头像或圆环阶段。
- `aemeath-closed-eyes.png`：基于同一背景由内置 ImageGen 编辑的闭眼补帧，启动与爱弥斯壁纸共享；绘制器仅合成双眼羽化区域，人物、猫和背景其它部分继续使用原图。提示词及来源见 `aemeath-NOTICE.md`。
- `baili-wallpaper.mp4`：来自同一运行包的无文字静音 `wallpaper.mp4`。
- 白璃「制作动画」复用无字视频生成轮廓与动态背景，文字作为独立图层编辑；不修改带字原片头。两个预设配置独立保存，可恢复原版白璃。

媒体许可说明保留在 `baili-NOTICE.md` 与 `aemeath-NOTICE.md`。仓库代码许可证不重新授权这些媒体。

`manifest.json` 固定两份视频、三份模板数据及两份声明的 SHA-256。声明使用 LF 换行，视频禁用 Git 文本转换，保证各平台检出后的字节一致。缺失、损坏或夹带额外媒体的旧构建输出会阻止出包。

仅更新素材时运行 `node packages/desktop/scripts/import-startup-media.mjs [startup.mp4]`，并一起审阅视频、声明和清单；普通开发与打包不需要运行导入脚本。

本仓库使用经过品牌替换的启动视频。重新维护时先在原工程的配置中设置 `title: "LCode"`，并把 `scene.mjs` 中的左上角标识改为 `OPENAI / LCode`，再通过原 `encodeVideo` 导出；不要直接用上游原版覆盖。导入时显式指定已重绘的文件，并保留本仓库的修改说明。上游原视频 SHA-256 为 `234eaa7a9046d0c6f4dd722bd74ec8b3076b747c11ca5adf0b44157191ac666f`。
