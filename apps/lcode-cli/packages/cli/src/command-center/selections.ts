import type { TuiSelection, TuiSelectionItem } from "@lcode/tui";
import type {
  CommandCenterCheckpoint,
  CommandCenterSession,
  CommandCenterTarget,
} from "./types.js";
import { formatTime, shortId, shortText } from "./utils.js";

const COMPOSER_SELECTION_PLACEMENT = "composer";

export function buildSessionSelection(sessions: CommandCenterSession[]): TuiSelection {
  return {
    emptyMessage: "No saved sessions found for this directory.",
    help: "Type to filter, Up/Down choose, Enter resumes, Esc cancels",
    items: sessions.map(sessionToSelectionItem),
    placement: COMPOSER_SELECTION_PLACEMENT,
    prompt: "Choose a session to resume.",
    title: "Resume Session",
  };
}

function sessionToSelectionItem(session: CommandCenterSession): TuiSelectionItem {
  const forkMeta = session.parentId ? `fork of ${shortId(session.parentId)}` : "root";
  return {
    command: `/resume ${session.id}`,
    id: session.id,
    keywords: [session.directory, session.title, session.parentId ?? ""],
    meta: `${formatTime(session.updatedAt)} | ${forkMeta}`,
    primary: session.title || session.id,
    secondary: `${shortId(session.id)} | ${session.directory}`,
  };
}

export function buildCheckpointSelection(
  action: "fork" | "rewind",
  checkpoints: CommandCenterCheckpoint[],
): TuiSelection {
  const verb = action === "fork" ? "fork from" : "rewind to";
  return {
    emptyMessage: "No workspace checkpoints are available yet.",
    help: `Type to filter, Up/Down choose, Enter ${verb}, Esc cancels`,
    items: checkpoints.map((checkpoint) => checkpointToSelectionItem(action, checkpoint)),
    ...(action === "rewind" ? { placement: COMPOSER_SELECTION_PLACEMENT } : {}),
    prompt: `Choose a checkpoint to ${verb}.`,
    title: action === "fork" ? "Fork From Checkpoint" : "Rewind To Checkpoint",
  };
}

function checkpointToSelectionItem(
  action: "fork" | "rewind",
  checkpoint: CommandCenterCheckpoint,
): TuiSelectionItem {
  const fileCount =
    checkpoint.fileCount === undefined
      ? "unknown files"
      : `${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? "" : "s"}`;
  const compact = checkpoint.coveredByCompact
    ? ` | compact ${checkpoint.compactBoundaryId ?? "covered"}`
    : "";
  const preview = checkpoint.preview ?? `message ${shortId(checkpoint.messageId)}`;
  return {
    command: `/${action} ${checkpoint.checkpointId}`,
    id: checkpoint.checkpointId,
    keywords: [
      checkpoint.messageId,
      checkpoint.scope,
      checkpoint.compactBoundaryId ?? "",
      checkpoint.preview ?? "",
    ],
    meta: `${fileCount} | ${formatTime(checkpoint.createdAt)}${compact}`,
    primary: preview,
    secondary: shortId(checkpoint.checkpointId),
  };
}

export function buildTargetReplaceSelection(
  existing: CommandCenterTarget,
  objective: string,
): TuiSelection {
  return {
    emptyMessage: "No goal replacement actions are available.",
    help: "Enter replaces the current goal, Esc cancels",
    items: [
      {
        command: `/goal replace ${objective}`,
        id: "replace-goal",
        keywords: [objective, existing.objective],
        meta: `Current: ${shortText(existing.objective, 80)}`,
        primary: "Replace current goal",
        secondary: shortText(objective, 100),
      },
    ],
    prompt: "Replace the current goal?",
    title: "Replace Goal",
  };
}
