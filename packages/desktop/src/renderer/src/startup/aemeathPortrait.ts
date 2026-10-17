const overlays = new WeakMap<HTMLImageElement, HTMLCanvasElement>();

export async function loadAemeathClosedEyes() {
  const image = new Image();
  image.src = new URL("./startup-media/aemeath-closed-eyes.png", document.baseURI).href;
  await image.decode();
  return image;
}

/** 只在双眼羽化遮罩内混合补帧；启动、预览与壁纸共用，原图其它像素保持原样。 */
export function drawAemeathPortrait(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  closed: HTMLImageElement,
  closure: number,
) {
  ctx.drawImage(image, 0, 0, 1536, 1024);
  if (closure <= 0) return;
  let overlay = overlays.get(closed);
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.width = 1536;
    overlay.height = 1024;
    const patch = overlay.getContext("2d")!;
    patch.drawImage(closed, 0, 0, 1536, 1024);
    const mask = document.createElement("canvas");
    mask.width = 1536;
    mask.height = 1024;
    const fill = mask.getContext("2d")!;
    fill.filter = "blur(4px)";
    fill.fillStyle = "white";
    // 遮罩需覆盖外侧上睫毛，椭圆会在角落漏出旧睫毛，造成闭眼残影。
    for (const [x, y, width, height] of [
      [542, 310, 154, 150],
      [770, 350, 164, 158],
    ]) {
      fill.beginPath();
      fill.roundRect(x, y, width, height, 16);
      fill.fill();
    }
    patch.globalCompositeOperation = "destination-in";
    patch.drawImage(mask, 0, 0);
    overlays.set(closed, overlay);
  }
  ctx.save();
  ctx.globalAlpha *= closure;
  // 裁到眼部补帧区域，避免在其它区域重复执行透明合成。
  for (const [x, y, width, height] of [
    [526, 294, 186, 182],
    [754, 334, 196, 190],
  ])
    ctx.drawImage(overlay, x, y, width, height, x, y, width, height);
  ctx.restore();
}
