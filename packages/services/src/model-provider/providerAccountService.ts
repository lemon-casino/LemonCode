import type { Event } from "@lcode/rpc";
import type {
  ProviderAccountView,
  ProviderAuthorization,
  StartProviderAuthorization,
  ProviderAccountQuota,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IProviderAccountService {
  readonly onDidChange: Event<ProviderAccountView>;
  getView(): Promise<ProviderAccountView>;
  checkinAccount(connectionId: string): Promise<ProviderAccountView>;
  checkinAll(channelId?: string): Promise<ProviderAccountView>;
  setAutomaticCheckin(connectionId: string, enabled: boolean): Promise<ProviderAccountView>;
  startAuthorization(input: StartProviderAuthorization): Promise<ProviderAuthorization>;
  getAuthorization(attemptId: string): Promise<ProviderAuthorization>;
  completeAuthorization(attemptId: string, code: string): Promise<ProviderAuthorization>;
  cancelAuthorization(attemptId: string): Promise<ProviderAuthorization>;
  refreshModels(connectionId: string): Promise<ProviderAccountView>;
  getQuota(connectionId: string, force?: boolean): Promise<ProviderAccountQuota>;
  removeAccount(connectionId: string): Promise<ProviderAccountView>;
  setAccountEnabled(connectionId: string, enabled: boolean): Promise<ProviderAccountView>;
}
export const IProviderAccountService = createServiceDescriptor<IProviderAccountService>(
  ServiceChannels.ProviderAccounts,
);
