/** 与同名构建脚本的公开接口一致，供 Main 消费，不增加第二份运行时身份状态。 */
export interface DesktopProductIdentity {
  readonly flavor: "production" | "preview";
  readonly appId: string;
  readonly productName: string;
  readonly linuxExecutableName: string;
  readonly linuxPackageName: string;
  readonly cuaHelperInstallVariant: "preview" | null;
}
type DesktopIdentityEnv = Readonly<Record<string, string | undefined>>;
export const LCODE_PREVIEW_IDENTITY_ENV: "LCODE_PREVIEW_IDENTITY";
export const desktopProductIdentities: Readonly<
  Record<"production" | "preview", DesktopProductIdentity>
>;
export function isPreviewIdentityRequested(env?: DesktopIdentityEnv): boolean;
export function resolveDesktopProductFlavor(env?: DesktopIdentityEnv): "production" | "preview";
export function resolveDesktopProductIdentity(env?: DesktopIdentityEnv): DesktopProductIdentity;
export function resolveDesktopArtifactSuffix(env?: DesktopIdentityEnv): "_TEST" | "";
export function resolveWindowsAppUserModelIdForFlavor(
  flavor: string,
  runtime?: { isPackaged: boolean },
): string;
export function resolveWindowsAppUserModelId(
  env?: DesktopIdentityEnv,
  runtime?: { isPackaged: boolean },
): string;
