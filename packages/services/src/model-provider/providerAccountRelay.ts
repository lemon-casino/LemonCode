import type {
  ProviderAccountRelayOpen,
  ProviderAccountRelayHead,
  ProviderAccountRelayChunk,
} from "@lcode/shared";
import type { IProviderAccountService } from "./providerAccountService.js";

/** 受信物理连接私有接口；不承载 OAuth grant，也不接受任意 URL 或认证头。 */
export interface ProviderAccountRelayService extends IProviderAccountService {
  open(input: ProviderAccountRelayOpen): Promise<ProviderAccountRelayHead>;
  read(requestId: string): Promise<ProviderAccountRelayChunk>;
  cancel(requestId: string): Promise<void>;
}
