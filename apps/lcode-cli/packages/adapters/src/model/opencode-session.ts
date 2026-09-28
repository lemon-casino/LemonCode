const OPENCODE_ROOT_DOMAIN = "opencode.ai";
const OPENCODE_GO_PATH = "/zen/go/v1";

export function isOpenCodeGoBaseUrl(baseURL: string | undefined): boolean {
  const trimmed = baseURL?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "").toLowerCase();
    return (
      (hostname === OPENCODE_ROOT_DOMAIN || hostname.endsWith(`.${OPENCODE_ROOT_DOMAIN}`)) &&
      path === OPENCODE_GO_PATH
    );
  } catch {
    return false;
  }
}
