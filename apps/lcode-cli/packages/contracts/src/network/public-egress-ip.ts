import { BlockList, isIP } from "node:net";

export type IpAddressVersion = 0 | 4 | 6;

export interface PublicEgressIpBlockReason {
  reason: string;
  version: IpAddressVersion;
}

interface BlockedIpRange {
  address: string;
  family: "ipv4" | "ipv6";
  prefix: number;
  reason: string;
}

const BLOCKED_IP_RANGES: BlockedIpRange[] = [
  { address: "0.0.0.0", family: "ipv4", prefix: 8, reason: "unspecified IPv4 address" },
  { address: "10.0.0.0", family: "ipv4", prefix: 8, reason: "private IPv4 address" },
  { address: "127.0.0.0", family: "ipv4", prefix: 8, reason: "loopback IPv4 address" },
  {
    address: "100.64.0.0",
    family: "ipv4",
    prefix: 10,
    reason: "carrier-grade NAT IPv4 address",
  },
  { address: "169.254.0.0", family: "ipv4", prefix: 16, reason: "link-local IPv4 address" },
  { address: "172.16.0.0", family: "ipv4", prefix: 12, reason: "private IPv4 address" },
  { address: "192.168.0.0", family: "ipv4", prefix: 16, reason: "private IPv4 address" },
  {
    address: "192.0.0.0",
    family: "ipv4",
    prefix: 24,
    reason: "IETF protocol assignment IPv4 address",
  },
  { address: "198.18.0.0", family: "ipv4", prefix: 15, reason: "benchmark IPv4 address" },
  { address: "224.0.0.0", family: "ipv4", prefix: 4, reason: "multicast IPv4 address" },
  { address: "240.0.0.0", family: "ipv4", prefix: 4, reason: "reserved IPv4 address" },
  { address: "::", family: "ipv6", prefix: 128, reason: "unspecified IPv6 address" },
  { address: "::1", family: "ipv6", prefix: 128, reason: "loopback IPv6 address" },
  { address: "fc00::", family: "ipv6", prefix: 7, reason: "unique-local IPv6 address" },
  { address: "fe80::", family: "ipv6", prefix: 10, reason: "link-local IPv6 address" },
  { address: "ff00::", family: "ipv6", prefix: 8, reason: "multicast IPv6 address" },
];

const BLOCKED_PUBLIC_EGRESS_RANGES = BLOCKED_IP_RANGES.map((range) => {
  const blockList = new BlockList();
  blockList.addSubnet(range.address, range.prefix, range.family);
  return { ...range, blockList };
});

export function normalizeIpAddressLiteral(value: string): string {
  return value.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

export function getIpAddressVersion(value: string): IpAddressVersion {
  return isIP(normalizeIpAddressLiteral(value)) as IpAddressVersion;
}

export function getPublicEgressIpBlockReason(value: string): PublicEgressIpBlockReason | undefined {
  const normalized = normalizeIpAddressLiteral(value);
  const version = isIP(normalized) as IpAddressVersion;
  if (version === 0) {
    return { reason: "not an IP address", version };
  }

  const family = version === 4 ? "ipv4" : "ipv6";
  // BlockList 按 CIDR 匹配时能覆盖 IPv4-mapped IPv6，
  // 避免手写正则漏掉 ::ffff:7f00:1 这类标准化后的 loopback 表示。
  for (const range of BLOCKED_PUBLIC_EGRESS_RANGES) {
    if (range.blockList.check(normalized, family)) {
      return { reason: range.reason, version };
    }
  }

  return undefined;
}
