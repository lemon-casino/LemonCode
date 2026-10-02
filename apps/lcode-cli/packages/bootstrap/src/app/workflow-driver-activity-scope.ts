import {
  SessionEventType,
  type ModelNetworkStatusEvent,
  type SessionEvent,
  type TurnStartedPayload,
} from "@lcode/contracts";
import type { InstanceRef } from "@lcode/dynamic-workflow";
import { sameAskAttempt } from "./workflow-driver-helpers.js";

/** executeTurn 的 queryId 认领 TurnStarted，再用真实 turnId 隔离该轮的请求、流和工具。 */
export function createActivityScope(live: () => InstanceRef | undefined) {
  let owner: InstanceRef | undefined;
  let queryId: string | undefined;
  let turnId: string | undefined;
  let sequence = 0;
  return {
    reset() {
      const instance = live();
      owner = instance === undefined ? undefined : { ...instance };
      queryId = undefined;
      turnId = undefined;
    },
    beginTurn(query: string) {
      queryId = query;
      turnId = undefined;
    },
    endTurn() {
      queryId = undefined;
      turnId = undefined;
    },
    instance: () => owner,
    accepts(event: SessionEvent): boolean {
      if (event.sequenceNumber > 0) {
        if (event.sequenceNumber <= sequence) return false;
        sequence = event.sequenceNumber;
      }
      if (owner === undefined || !sameAskAttempt(live(), owner) || queryId === undefined)
        return false;
      if (event.type === SessionEventType.TurnStarted) {
        const payload = event.payload as TurnStartedPayload;
        if (payload.queryId !== queryId || event.turnId === undefined) return false;
        if (turnId !== undefined && turnId !== event.turnId) return false;
        turnId = event.turnId;
        return true;
      }
      if (turnId === undefined || event.turnId !== turnId) return false;
      if (event.type === SessionEventType.ModelNetworkStatus) {
        const status = event.payload as ModelNetworkStatusEvent;
        if (status.turnId !== undefined && status.turnId !== turnId) return false;
        if (status.sessionId !== undefined && status.sessionId !== event.sessionId) return false;
      }
      return true;
    },
  };
}

/** 时间来自事件，不以接收、flush 或当前时钟补齐缺失/损坏的源时间。 */
export function activitySourceTime(value: unknown): number | undefined {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : undefined;
  return time !== undefined && Number.isSafeInteger(time) && time >= 0 ? time : undefined;
}
