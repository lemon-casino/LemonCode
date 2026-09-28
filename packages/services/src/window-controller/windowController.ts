import type { Event } from "@lcode/rpc";
import { ServiceChannels } from "@lcode/shared";
import type { LCodeTaskMeta } from "@lcode/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@lcode/shared/lcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { LCodeArchivedTaskDeletionResult } from "#src/session/lcodeTaskService.js";
import type {
  LCodeTaskListItem,
  LCodeTaskListQuery,
  LCodeTaskListResult,
} from "../session/lcodeTaskListTypes.js";

export type WindowHostControllerMutation =
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerTaskListItem = LCodeTaskListItem & {
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  activity?: WindowHostControllerTaskRow["activity"];
};

export interface WindowHostControllerTaskListResult extends Omit<LCodeTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/**
 * 窗口级 Controller 服务只承载列表投影与跨 source 路由。
 * conversation/file/git/terminal 仍由 attachment 对应的 scoped facade 提供。
 */
export interface IWindowControllerService {
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<LCodeArchivedTaskDeletionResult>;
  listTaskList(params: LCodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<LCodeTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);
