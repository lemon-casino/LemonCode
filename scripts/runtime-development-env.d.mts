type DevelopmentEnvironment = Readonly<Record<string, string | undefined>>;

/** Empty values use the fallback; non-empty values must be decimal integers 1..65535. */
export function resolveDevelopmentPort(
  name: string,
  value: string | undefined,
  fallback: number,
): number;
export function resolveWebPort(env?: DevelopmentEnvironment): number;
export function resolveServerPort(env?: DevelopmentEnvironment): number;
export function resolveDesktopPort(env?: DevelopmentEnvironment): number;
export function resolveServerHost(env?: DevelopmentEnvironment): string;
export function resolveServerProxyHost(env?: DevelopmentEnvironment): string;
export function assertRuntimeDevelopmentDataRoot(env?: DevelopmentEnvironment): void;
export function withDefaultDevelopmentDataRoot(
  env: DevelopmentEnvironment,
  defaultRoot: string,
): DevelopmentEnvironment;
