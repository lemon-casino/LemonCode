export type CodingPlanResetType = "FIVE_HOUR" | "WEEK";

export interface CodingPlanResetScopeRequest {
  preferredProviderId: string;
  /** Registry 静态访问类别，或调用边界已解析的 Team scope。 */
  accountAccess: LCodeProviderAccountAccess | LCodeAccountAccess;
}

export interface CodingPlanResetOpportunitySnapshot {
  expireAt: number;
}

export interface CodingPlanResetHistorySnapshot {
  usedAt: number;
}

export interface CodingPlanResetStatusSnapshot {
  availableFiveHourResets: CodingPlanResetOpportunitySnapshot[];
  availableWeekResets: CodingPlanResetOpportunitySnapshot[];
  latestFiveHourResetHistory: CodingPlanResetHistorySnapshot | null;
  latestWeekResetHistory: CodingPlanResetHistorySnapshot | null;
  hasUnreadHistory: boolean;
}

export interface CodingPlanResetOpportunityRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
}

export interface CodingPlanResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}

export interface CodingPlanResetUseRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
  resetType: CodingPlanResetType;
}

export interface CodingPlanResetUseResult {
  used: true;
}
import type { LCodeAccountAccess, LCodeProviderAccountAccess } from "./lcode-protocol/index.js";
