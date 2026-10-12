/** 默认代理、供应商配置与表单共用的协议和 userinfo 编码规则。 */
export const NETWORK_PROXY_PROTOCOLS = ["http:", "https:", "socks5:"] as const;

export function isNetworkProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      Boolean(url.hostname) && NETWORK_PROXY_PROTOCOLS.some((protocol) => protocol === url.protocol)
    );
  } catch {
    return false;
  }
}

export function splitNetworkProxyUrl(value: string): {
  address: string;
  username: string;
  password: string;
} {
  try {
    const url = new URL(value);
    const decode = (part: string) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const username = decode(url.username);
    const password = decode(url.password);
    url.username = "";
    url.password = "";
    return { address: url.href.replace(/\/$/, ""), username, password };
  } catch {
    return { address: value, username: "", password: "" };
  }
}

export function joinNetworkProxyUrl(address: string, username: string, password: string): string {
  try {
    const url = new URL(address.trim());
    url.username = encodeURIComponent(username);
    url.password = encodeURIComponent(password);
    return url.href.replace(/\/$/, "");
  } catch {
    return address;
  }
}

/** 合法的百分号编码按 URI 解码；裸百分号按字面凭据重编码，避免握手时 URIError。 */
export function normalizeNetworkProxyUrl(value: string): string {
  const parts = splitNetworkProxyUrl(value);
  return new URL(joinNetworkProxyUrl(parts.address, parts.username, parts.password)).href;
}
import { z } from "zod";

export const proxyProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    httpProxy: z.string().refine(isNetworkProxyUrl).transform(normalizeNetworkProxyUrl),
    noProxy: z.string().optional(),
    caCertPath: z.string().optional(),
  })
  .strict()
  .readonly();
export const proxyProfilesSchema = z
  .array(proxyProfileSchema)
  .max(1000)
  .readonly()
  .superRefine((profiles, context) => {
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
      context.addIssue({ code: "custom", message: "Duplicate proxy profile id" });
  });
export type ProxyProfile = Readonly<z.infer<typeof proxyProfileSchema>>;
export interface ProxyConnectivityResult {
  readonly profileId: string;
  readonly status: "reachable" | "failed";
  readonly latencyMs: number;
}

export function parseNetworkProxyLines(text: string): { urls: string[]; invalidLines: number[] } {
  if (new TextEncoder().encode(text).byteLength > 256 * 1024)
    throw new Error("Proxy import exceeds 256 KiB");
  const urls = new Set<string>();
  const invalidLines: number[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const value = raw.trim();
    if (!value) continue;
    if (!isNetworkProxyUrl(value)) invalidLines.push(index + 1);
    else urls.add(normalizeNetworkProxyUrl(value));
  }
  if (urls.size > 1000) throw new Error("Proxy import exceeds 1000 entries");
  return { urls: [...urls], invalidLines };
}
