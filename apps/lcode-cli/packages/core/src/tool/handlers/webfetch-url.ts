import {
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "@lcode/contracts";
import { MAX_WEBFETCH_URL_CHARS } from "./webfetch-constants.js";
import { isWebFetchIpLiteral } from "./webfetch-egress-guard.js";
import { webFetchError } from "./webfetch-errors.js";

export function normalizeWebFetchUrl(value: string): URL {
  if (value.length > MAX_WEBFETCH_URL_CHARS) {
    throw webFetchError("InvalidUrl", "URL is too long", {
      maxLength: MAX_WEBFETCH_URL_CHARS,
      urlLength: value.length,
    });
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw webFetchError("InvalidUrl", `Invalid URL: ${value}`, { url: value }, error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw webFetchError("UnsupportedProtocol", "WebFetch only supports http and https URLs", {
      protocol: url.protocol,
      url: value,
    });
  }

  if (url.username || url.password) {
    throw webFetchError("CredentialsInUrl", "WebFetch URLs must not include credentials", {
      url: redactUrlCredentials(url),
    });
  }

  // provider-visible WebFetch 约定会把模型传入的 HTTP URL 升级成 HTTPS 后再出站请求。
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  assertPublicHost(url);
  return url;
}

export function resolveRedirectUrl(location: string, currentUrl: URL): URL {
  try {
    return new URL(location, currentUrl);
  } catch (error) {
    throw webFetchError(
      "UnsafeRedirect",
      `Redirect Location is not a valid URL: ${location}`,
      {
        location,
        url: currentUrl.toString(),
      },
      error,
    );
  }
}

export function isPermittedRedirect(from: URL, to: URL): boolean {
  if (to.username || to.password) {
    return false;
  }

  if (!isPublicHost(to)) {
    return false;
  }

  if (from.protocol !== to.protocol || effectivePort(from) !== effectivePort(to)) {
    return false;
  }

  if (!sameHostModuloWww(from.hostname, to.hostname)) {
    return false;
  }

  return true;
}

export function redactUrlCredentials(url: URL): string {
  const clone = new URL(url);
  clone.username = "";
  clone.password = "";
  return clone.toString();
}

function assertPublicHost(url: URL): void {
  const blocked = getBlockedHostReason(url);
  if (!blocked) return;
  throw webFetchError("InvalidUrl", blocked.message, {
    hostname: blocked.hostname,
    url: url.toString(),
  });
}

function isPublicHost(url: URL): boolean {
  return getBlockedHostReason(url) === undefined;
}

function getBlockedHostReason(
  url: URL,
): { hostname: string; message: string } | undefined {
  const hostname = normalizeHostname(url.hostname);
  if (hostname.length === 0) {
    return { hostname, message: "URL must include a hostname" };
  }

  // URL 层只负责稳定的形态过滤；WebFetch 的本地字面量 IP egress
  // guard 贴近每次真实 GET，普通域名不再做 DNS preflight。
  if (isWebFetchIpLiteral(hostname)) {
    return undefined;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { hostname, message: "WebFetch requires a public hostname" };
  }

  const ipVersion = getIpAddressVersion(hostname);
  const blockedIp = ipVersion === 0 ? undefined : getPublicEgressIpBlockReason(hostname);
  if (blockedIp && ipVersion === 4) {
    return { hostname, message: "WebFetch blocks non-public IPv4 hosts" };
  }
  if (blockedIp && ipVersion === 6) {
    return { hostname, message: "WebFetch blocks non-public IPv6 hosts" };
  }

  if (ipVersion === 0 && hostname.split(".").length < 2) {
    return { hostname, message: "Invalid URL" };
  }

  return undefined;
}

function normalizeHostname(hostname: string): string {
  return normalizeIpAddressLiteral(hostname);
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function sameHostModuloWww(left: string, right: string): boolean {
  return stripWww(left) === stripWww(right);
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}
