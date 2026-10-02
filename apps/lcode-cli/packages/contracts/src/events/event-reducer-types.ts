import type { SessionProjection } from "../interfaces/session.port.js";
import type { SessionEvent } from "./session.events.js";

/** 事件投影只读旧状态并返回新状态；队列与事件持久化仍归原宿主所有。 */
export type EventProjectionHandlers = Record<
  string,
  (projection: SessionProjection, event: SessionEvent) => SessionProjection
>;
