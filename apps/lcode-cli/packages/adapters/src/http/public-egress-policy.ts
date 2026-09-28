import { lookup as defaultDnsLookup } from "node:dns/promises";
import http from "node:http";
import {
  createHttpClientError,
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "@lcode/contracts";

export type DnsLookupAddress = { address: string; family: number };
export type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsLookupAddress[]>;

type NodeLookupFunction = NonNullable<http.RequestOptions["lookup"]>;

interface PublicEgressLookupOptions {
  signal?: AbortSignal;
}

export function defaultPublicDnsLookup(): DnsLookup {
  return defaultDnsLookup;
}

export async function assertPublicEgressDestination(
  url: URL,
  dnsLookup: DnsLookup,
  options: PublicEgressLookupOptions = {},
): Promise<void> {
  await resolvePublicEgressAddresses(url, url.hostname, dnsLookup, options);
}

export function createPublicEgressLookup(
  url: string,
  dnsLookup: DnsLookup,
  egressOptions: PublicEgressLookupOptions = {},
): NodeLookupFunction {
  return (hostname, lookupOptions, callback) => {
    const done = typeof lookupOptions === "function" ? lookupOptions : callback;
    const wantsAll =
      typeof lookupOptions === "object" &&
      lookupOptions !== null &&
      "all" in lookupOptions &&
      (lookupOptions as { all?: unknown }).all === true;

    if (!done) return;

    resolvePublicEgressAddresses(new URL(url), hostname, dnsLookup, egressOptions).then(
      (addresses) => {
        if (wantsAll) {
          (
            done as (error: NodeJS.ErrnoException | null, addresses: DnsLookupAddress[]) => void
          )(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          (done as (error: NodeJS.ErrnoException) => void)(
            createEgressBlockedError(url, "HTTP public egress DNS lookup returned no addresses"),
          );
          return;
        }
        (
          done as (
            error: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void
        )(null, first.address, first.family);
      },
      (error: unknown) => {
        (done as (error: NodeJS.ErrnoException) => void)(toLookupError(error));
      },
    );
  };
}

async function resolvePublicEgressAddresses(
  url: URL,
  hostnameValue: string,
  dnsLookup: DnsLookup,
  options: PublicEgressLookupOptions,
): Promise<DnsLookupAddress[]> {
  const hostname = normalizeHostname(hostnameValue);
  if (hostname.length === 0) {
    throw createEgressBlockedError(url.toString(), "HTTP public egress requires a hostname");
  }

  const hostReason = getBlockedHostnameReason(hostname);
  if (hostReason) {
    throw createEgressBlockedError(url.toString(), hostReason);
  }

  const ipVersion = getIpAddressVersion(hostname);
  const addresses =
    ipVersion === 0
      ? await lookupDnsAddresses(hostname, dnsLookup, options.signal)
      : [{ address: hostname, family: ipVersion }];

  if (addresses.length === 0) {
    throw createEgressBlockedError(
      url.toString(),
      `HTTP public egress DNS lookup returned no addresses for ${hostname}`,
    );
  }

  for (const address of addresses) {
    const blockedAddress = getBlockedIpReason(address.address);
    if (blockedAddress) {
      throw createEgressBlockedError(
        url.toString(),
        `HTTP public egress blocked ${hostname} because it resolved to a non-public address`,
      );
    }
  }

  return addresses;
}

function normalizeHostname(hostname: string): string {
  return normalizeIpAddressLiteral(hostname);
}

function getBlockedHostnameReason(hostname: string): string | undefined {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return `HTTP public egress blocked local hostname ${hostname}`;
  }

  if (getIpAddressVersion(hostname) === 0 && hostname.split(".").length < 2) {
    return "HTTP public egress requires a public hostname";
  }

  return undefined;
}

function getBlockedIpReason(address: string): string | undefined {
  return getPublicEgressIpBlockReason(address)?.reason;
}

function lookupDnsAddresses(
  hostname: string,
  dnsLookup: DnsLookup,
  signal: AbortSignal | undefined,
): Promise<DnsLookupAddress[]> {
  throwIfAborted(signal);
  const lookup = dnsLookup(hostname, { all: true, verbatim: true });
  if (!signal) return lookup;
  throwIfAborted(signal);

  // public egress 的 DNS 预检在真正建连前执行，也必须继承同一个请求超时/取消边界。
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    lookup.then(
      (addresses) => {
        signal.removeEventListener("abort", onAbort);
        resolve(addresses);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("HTTP request was cancelled");
}

function createEgressBlockedError(url: string, message: string): Error {
  return createHttpClientError({
    code: "egress_blocked",
    url,
    message,
  });
}

function toLookupError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) return error as NodeJS.ErrnoException;
  return new Error(String(error)) as NodeJS.ErrnoException;
}
