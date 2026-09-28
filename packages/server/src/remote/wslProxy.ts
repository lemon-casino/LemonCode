import { isIP } from "node:net";
import { quotePosixShellArg } from "@lcode/server/remote/posixShell.js";

const LOOPBACK_IPV4_PREFIX = "127.";
const LINK_LOCAL_IPV4_PREFIX = "169.254.";

export function normalizeWslProxyUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol.length > 0 && url.hostname.length > 0 ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isLoopbackProxyHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith(LOOPBACK_IPV4_PREFIX))
  );
}

export function replaceProxyHostname(proxyUrl: string, hostname: string): string {
  const url = new URL(proxyUrl);
  if (isIP(hostname) === 6) {
    url.hostname = `[${hostname}]`;
  } else {
    url.hostname = hostname;
  }
  return url.toString();
}

export function buildWslProxyPortProbeCommand(proxyUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return null;
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!/^\d+$/u.test(port)) {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const tcpTarget = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const probeScript = `:</dev/tcp/${tcpTarget}/${port}`;
  return [
    "if command -v timeout >/dev/null 2>&1 &&",
    `timeout 1 bash -c ${quotePosixShellArg(probeScript)} >/dev/null 2>&1; then`,
    "printf reachable",
    "else",
    "printf unreachable",
    "fi",
  ].join(" ");
}

export function parseWslProxyPortProbeOutput(output: string): boolean | undefined {
  const normalized = output.trim();
  if (normalized === "reachable") {
    return true;
  }
  if (normalized === "unreachable") {
    return false;
  }
  return undefined;
}

export function buildWslHostGatewayCommand(): string {
  return [
    "gateway=",
    'if command -v ip >/dev/null 2>&1; then gateway=$(ip route show default 2>/dev/null | awk \'$1=="default" && $2=="via" {print $3; exit}\'); fi',
    'if [ -n "$gateway" ]; then printf "route=%s " "$gateway"; fi',
    'if [ -r /etc/resolv.conf ]; then awk \'$1=="nameserver" {print "resolv=" $2}\' /etc/resolv.conf; fi',
  ].join("; ");
}

export function parseWslHostGatewayOutput(output: string): string | null {
  for (const token of output.trim().split(/\s+/u)) {
    const taggedCandidate = /^(route|resolv)=(.+)$/u.exec(token);
    const source = taggedCandidate?.[1] ?? "resolv";
    const candidate = (taggedCandidate?.[2] ?? token).replace(/^\[|\]$/gu, "");
    if (isWslGatewayCandidate(candidate, source)) {
      return candidate;
    }
  }
  return null;
}

function isWslGatewayCandidate(candidate: string, source: string): boolean {
  const addressType = isIP(candidate);
  if (addressType !== 4 && addressType !== 6) {
    return false;
  }
  if (candidate === "::1" || (addressType === 4 && candidate.startsWith(LOOPBACK_IPV4_PREFIX))) {
    return false;
  }
  if (source !== "resolv") {
    return true;
  }
  return isPrivateOrLinkLocalAddress(candidate, addressType);
}

function isPrivateOrLinkLocalAddress(candidate: string, addressType: number): boolean {
  if (addressType === 6) {
    const normalized = candidate.toLowerCase();
    return (
      normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized)
    );
  }
  const octets = candidate.split(".").map(Number);
  const firstOctet = octets[0] ?? -1;
  const secondOctet = octets[1] ?? -1;
  return (
    octets.length === 4 &&
    (firstOctet === 10 ||
      (firstOctet === 192 && secondOctet === 168) ||
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
      candidate.startsWith(LINK_LOCAL_IPV4_PREFIX))
  );
}

export function formatWslProxyForLog(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const displayHost = isIP(host) === 6 ? `[${host}]` : host;
    return `${url.protocol}//${displayHost}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "<invalid-proxy>";
  }
}
