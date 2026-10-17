import { drawAemeathPortrait } from "./aemeathPortrait.js";
import type { SceneResource } from "./sceneResource.js";

/** 原资源与渐进着色共用一个离屏画布，展示器卸载时释放其纹理。 */
export function createSceneArtwork() {
  const art = document.createElement("canvas");
  art.width = 1536;
  art.height = 1024;
  const paint = art.getContext("2d")!;
  return {
    draw(
      target: CanvasRenderingContext2D,
      resource: SceneResource,
      closedEyes: HTMLImageElement | undefined,
      color: number,
      blink: number,
    ) {
      paint.globalCompositeOperation = "source-over";
      paint.clearRect(0, 0, 1536, 1024);
      if (closedEyes && resource.kind === "image")
        drawAemeathPortrait(paint, resource.element, closedEyes, blink);
      else {
        const scale = Math.max(1536 / resource.width, 1024 / resource.height);
        paint.drawImage(
          resource.element,
          (1536 - resource.width * scale) / 2,
          (1024 - resource.height * scale) / 2,
          resource.width * scale,
          resource.height * scale,
        );
      }
      // 旧实现整幅淡入跳过描绘细节，原始像素应沿描线方向逐渐生成。
      if (color < 1) {
        const front = color * 1632 - 48;
        const mask = paint.createLinearGradient(front - 48, 0, front + 48, 0);
        mask.addColorStop(0, "white");
        mask.addColorStop(1, "transparent");
        paint.globalCompositeOperation = "destination-in";
        paint.fillStyle = mask;
        paint.fillRect(0, 0, 1536, 1024);
      }
      target.drawImage(art, 0, 0);
    },
    dispose() {
      art.width = art.height = 1;
    },
  };
}
