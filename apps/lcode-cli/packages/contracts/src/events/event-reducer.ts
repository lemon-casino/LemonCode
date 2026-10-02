// Event Reducer - ordered, pure state projection through the original public surface.

import type { SessionEvent } from "./session.events.js";
import type { SessionProjection } from "../interfaces/session.port.js";
import { initialSessionProjection } from "./event-reducer-helpers.js";
import { lifecycleProjectionHandlers } from "./event-reducer-lifecycle.js";
import { goalProjectionHandlers } from "./event-reducer-goal.js";
import { queueProjectionHandlers } from "./event-reducer-queue.js";
import { toolProjectionHandlers } from "./event-reducer-tools.js";

export class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }

  private handlers: Record<
    string,
    (projection: SessionProjection, event: SessionEvent) => SessionProjection
  > = {
    ...lifecycleProjectionHandlers,
    ...goalProjectionHandlers,
    ...queueProjectionHandlers,
    ...toolProjectionHandlers,
  };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
