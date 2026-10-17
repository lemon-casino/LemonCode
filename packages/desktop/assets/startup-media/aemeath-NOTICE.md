# 爱弥斯启动模板来源

背景和原始轮廓来自用户提供的 codex-startup-animation 项目。原项目未指定开源许可证，角色、素材及品牌权利归相应权利人，本仓库不额外授权。

LCode 使用独立 Canvas 渲染器重新制作可编辑模板：移除头像、圆环和头像碎片，使用线段碎片、描线、着色和中央收拢；不分发原生启动器、CDP 或原项目设置实现。

## LCode 眨眼补帧（2026-10-17）

`aemeath-closed-eyes.png` 使用内置 ImageGen 工具编辑 `aemeath-artwork.jpg`，1536×1024。只在双眼的局部羽化遮罩中混合该补帧，避免模型对其它区域的变化进入实际动画。原图及补帧随安装包分发，无运行时生成或网络请求；不改变原素材权利归属。

最终提示词：

> Use case: precise-object-edit. Edit target: the supplied 1536x1024 anime illustration, a game character with pink hair holding a white cat in an office. Asset: closed-eye frame for a very precise blink animation in LCode. Preserve the EXACT composition, camera, expression, mouth, all hair, face outline, cat (including its OPEN eyes), costume and background, original colors, pixel positions, and canvas aspect ratio. Change ONLY the pink-haired woman's TWO eyes: gently closed eyelids with elegant downward-curved dark eyelashes, relaxed natural blink (not smiling squeezed shut), both irises fully hidden by skin, matching her original peach skin shading. Keep her eyebrows unchanged, do not move or resize her face, do not change the cat's eyes. This is a matching animation frame, not a redesign. No text or additions, no crop, same 1536x1024 dimensions if possible.

# 参考与素材说明

以下项目用于研究实现方式。本项目未复制其源代码，也不需要安装或运行它们。

| 参考项目                                                                          | 参考范围                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Tangc/codex-skin-launcher](https://github.com/Tangc/codex-skin-launcher)         | macOS 原生窗口、应用标识与独立启动入口                   |
| [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin)         | 整窗壁纸、透明表面、本机 CDP 接入及目标进程校验          |
| [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) | 可跳过的覆盖式片头、完成后移除、素材就绪后播放和超时兜底 |

DSH 使用自己的覆盖层接口，不能直接安装到 Codex。本项目的动画和外部接入独立实现，不引入视频片库或第三方运行时依赖，也不使用持续监控进程。

## 视觉素材

- 默认头像和背景来自项目所有者提供的本地图片，经过确定性的缩放与居中裁切。
- `assets/contours.js` 从运行用背景通过 macOS Vision 提取。自定义背景在导入时由本机 Canvas 生成轮廓。
- 粉色启动图标基于官方花形标志进行颜色编辑，仅用于区分个人启动入口。原标志的权利归相应权利人。
- 早期原型曾用参考视频的截图和 ImageGen 重建头像及背景；这些备用图片、截图与视频不在本次提交范围内。
- 动画本身由 HTML、CSS、Canvas 和 SVG 绘制，无音轨、远程字体、CDN 或在线图片请求。

动画从头像碎片过渡到背景的散线，再从左到右汇聚，最后显现彩色图。人物素材、品牌标志和项目代码的权利应分别看待；未对第三方素材授予任何额外许可。
