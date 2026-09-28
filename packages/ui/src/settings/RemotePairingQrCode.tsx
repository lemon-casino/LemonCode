// 配对二维码渲染：桌面 Main 生成 pairingUrl（capability 只在 fragment），
// Renderer 只负责把同一个 URL 字符串渲染成二维码（PROTOCOL.md §5：
// 扫码与复制链接必须使用同一 URL，两条路径等价）。
// 二维码固定黑块白底，不跟随主题——扫码器依赖高对比度，主题色可能导致部分手机无法识别。
import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

interface RemotePairingQrCodeProps {
  url: string;
  /** CSS 显示边长（px）；内部按 2 倍渲染以适配高分屏。 */
  size?: number;
}

export function RemotePairingQrCode({ url, size = 208 }: RemotePairingQrCodeProps) {
  const { intl } = useLCodeIntl();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);
    toDataURL(url, {
      // 2 倍尺寸导出位图，CSS 再缩回显示尺寸，避免高分屏扫码出现锯齿影响识别。
      width: size * 2,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((next) => {
        if (!cancelled) setDataUrl(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [size, url]);

  if (failed) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-border bg-surface text-ui-sm text-foreground-subtle"
        style={{ width: size, height: size }}
      >
        {intl.formatMessage({ id: "settings.remoteControl.pairing.qrFailed" })}
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center rounded-lg bg-white p-2"
      style={{ width: size + 16, height: size + 16 }}
    >
      {dataUrl ? (
        <img
          src={dataUrl}
          width={size}
          height={size}
          alt={intl.formatMessage({ id: "settings.remoteControl.pairing.qrAlt" })}
          className="block"
        />
      ) : (
        <div className="animate-pulse rounded bg-surface" style={{ width: size, height: size }} />
      )}
    </div>
  );
}
