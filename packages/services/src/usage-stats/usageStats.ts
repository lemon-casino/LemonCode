import type {
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  getCodingPlanUsageSnapshot(request: CodingPlanUsageRequest): Promise<CodingPlanUsageSnapshot>;
  getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot>;
  requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult>;
  useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult>;
  markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void>;
  getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot>;
  getEntitlementSnapshot(request?: UsageEntitlementRequest): Promise<UsageEntitlementSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
