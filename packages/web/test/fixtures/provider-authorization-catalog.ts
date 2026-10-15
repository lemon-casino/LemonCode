import type { ProviderAccountChannel } from "@lcode/shared";

// 仅注入安全的方法目录；浏览器夹具不会加载Host驱动或读取真实账号。
export const fixtureAuthorizationChannels: readonly ProviderAccountChannel[] = (
  window as Window & { __providerAuthorizationChannels?: readonly ProviderAccountChannel[] }
).__providerAuthorizationChannels ?? [
  {
    id: "fixture",
    name: "Fixture OAuth",
    checkinSupported: new URLSearchParams(location.search).has("checkin"),
    methods: [
      { id: "code", label: "Browser code", type: "oauth", kind: "browser" },
      ...(new URLSearchParams(location.search).has("sources")
        ? [
            {
              id: "file",
              label: "Fixture credential files",
              type: "oauth" as const,
              kind: "import" as const,
              description: "Import fixture account exports. Existing credentials are read only.",
            },
            {
              id: "local",
              label: "Fixture CLI sign-in",
              type: "oauth" as const,
              kind: "local" as const,
              description: "Reads the selected Host's fixture CLI sign-in.",
            },
          ]
        : []),
    ],
  },
];
