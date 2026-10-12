import type { ProviderConfigObject } from "@lcode/provider";
import { PackageIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useLCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme, type ResolvedTheme } from "@/useTheme.js";
import alibabaModelStudioLogo from "@/assets/provider-icons/model-provider-alibaba-cloud.png";
import anthropicLogo from "@/assets/provider-icons/model-provider-anthropic.png";
import bigModelLogo from "@/assets/provider-icons/logo-bigmodel.svg";
import deepSeekLogo from "@/assets/provider-icons/model-provider-deepseek.png";
import miniMaxLogo from "@/assets/provider-icons/model-provider-minimax.png";
import moonshotKimiLogo from "@/assets/provider-icons/model-provider-moonshot-kimi.png";
import openAiLogo from "@/assets/provider-icons/model-provider-openai.png";
import xAiLogo from "@/assets/provider-icons/model-provider-xai.png";
import xiaomiMimoLogo from "@/assets/provider-icons/model-provider-xiaomi-mimo.png";
import startPlanLogo from "@/assets/provider-icons/model-provider-start-plan.png";
import zaiLogo from "@/assets/provider-icons/model-provider-zai-app.png";
import openrouterLight from "@/assets/provider-icons/model-provider-openrouter-light.svg";
import openrouterDark from "@/assets/provider-icons/model-provider-openrouter-dark.svg";
import opencodeLight from "@/assets/provider-icons/model-provider-opencode-light.svg";
import opencodeDark from "@/assets/provider-icons/model-provider-opencode-dark.svg";
import copilotLogo from "@/assets/provider-icons/model-provider-copilot.svg";
import geminiCliLogo from "@/assets/provider-icons/model-provider-gemini-cli.svg";
import antigravityLogo from "@/assets/provider-icons/model-provider-antigravity.svg";
import clineLogo from "@/assets/provider-icons/model-provider-cline.svg";
import commandCodeLogo from "@/assets/provider-icons/model-provider-commandcode.svg";
import cursorLogo from "@/assets/provider-icons/model-provider-cursor.svg";
import devinLogo from "@/assets/provider-icons/model-provider-devin.svg";
import factoryLogo from "@/assets/provider-icons/model-provider-factory.svg";
import kiroLogo from "@/assets/provider-icons/model-provider-kiro.svg";
import qoderLogo from "@/assets/provider-icons/model-provider-qoder.svg";
import traeLogo from "@/assets/provider-icons/model-provider-trae.svg";
import workBuddyLogo from "@/assets/provider-icons/model-provider-workbuddy.svg";
import zedLogo from "@/assets/provider-icons/model-provider-zed.svg";

type ProviderLogoRef = NonNullable<ProviderConfigObject["logo"]>;

interface BuiltinProviderLogoAsset {
  readonly light: string;
  readonly dark?: string;
  readonly monochrome?: boolean;
}

// 这里只负责把 Config 中的资源 key 解析为打包素材；禁止加入 Provider ID、名称或排序逻辑。
const BUILTIN_PROVIDER_LOGO_ASSETS: Readonly<Record<string, BuiltinProviderLogoAsset>> = {
  // 用户指定 Dock 应用图标；同名旧 SVG 带灰色描边，不能当作同一素材复用。
  zai: { light: zaiLogo },
  bigmodel: { light: bigModelLogo },
  "start-plan": { light: startPlanLogo },
  "moonshot-kimi": { light: moonshotKimiLogo },
  minimax: { light: miniMaxLogo },
  deepseek: { light: deepSeekLogo },
  "alibaba-model-studio": { light: alibabaModelStudioLogo },
  "xiaomi-mimo": { light: xiaomiMimoLogo },
  openai: { light: openAiLogo },
  anthropic: { light: anthropicLogo },
  xai: { light: xAiLogo },
  openrouter: { light: openrouterLight, dark: openrouterDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
  copilot: { light: copilotLogo, monochrome: true },
  "gemini-cli": { light: geminiCliLogo },
  antigravity: { light: antigravityLogo },
  cline: { light: clineLogo, monochrome: true },
  commandcode: { light: commandCodeLogo, monochrome: true },
  cursor: { light: cursorLogo, monochrome: true },
  devin: { light: devinLogo, monochrome: true },
  factory: { light: factoryLogo, monochrome: true },
  kiro: { light: kiroLogo },
  qoder: { light: qoderLogo, monochrome: true },
  trae: { light: traeLogo, monochrome: true },
  workbuddy: { light: workBuddyLogo },
  zed: { light: zedLogo, monochrome: true },
};

function resolveBuiltinProviderLogoAsset(
  logo: ProviderLogoRef | null | undefined,
  theme: ResolvedTheme,
): string | null {
  if (logo?.type !== "builtin") {
    return null;
  }
  const asset = BUILTIN_PROVIDER_LOGO_ASSETS[logo.key];
  return asset ? (theme === "dark" ? (asset.dark ?? asset.light) : asset.light) : null;
}

export function ProviderLogo({
  logo,
  className,
}: {
  logo?: ProviderLogoRef | null;
  className?: string;
}) {
  const theme = useLCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const src = resolveBuiltinProviderLogoAsset(logo, resolveTheme(theme));
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return <PackageIcon className={cn("shrink-0", className)} aria-hidden="true" />;
  }
  const key = logo?.type === "builtin" ? logo.key : undefined;
  // SVG作为img不会继承页面的currentColor；用原始素材的alpha作mask，深浅主题都沿用前景色。
  if (key && BUILTIN_PROVIDER_LOGO_ASSETS[key]?.monochrome) {
    const maskImage = `url(${JSON.stringify(src)})`;
    return (
      <span
        data-provider-logo={key}
        aria-hidden="true"
        className={cn("shrink-0 bg-current", className)}
        style={{
          maskImage,
          WebkitMaskImage: maskImage,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    );
  }
  return (
    <img
      data-provider-logo={key}
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain", className)}
      onError={() => setFailedSrc(src)}
    />
  );
}
