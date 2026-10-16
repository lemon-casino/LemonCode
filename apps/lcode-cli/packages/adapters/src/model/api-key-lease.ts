import type {
  ProviderApiKey,
  RoutingFinish,
  SharedQuotaInput,
  RoutingWindow,
} from "@lcode/provider";
export interface ApiKeyLease {
  readonly key: ProviderApiKey;
  readonly canRotate: boolean;
  readonly sharedQuotaInput?: Omit<SharedQuotaInput, "providerId">;
  sharedQuotaWindows?(): readonly RoutingWindow[];
  admit?(): Promise<boolean>;
  rollbackDispatch?(): Promise<void>;
  flushRouting?(): Promise<void>;
  observe(status: number, headers?: Headers): void;
  release(): void;
  begin?(): boolean;
  end?(success: boolean): void;
  observeUsage?(usage: RoutingFinish): void;
}
