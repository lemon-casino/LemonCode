import React from "react";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import type {
  LCodeSessionSubagentsResult,
  LCodeSessionRunningSubagent,
  LCodeSessionEndedSubagent,
} from "@lcode/shared";
import type { TuiOptions } from "./types.js";
import { changesSubagentDirectory } from "./app-subagent-events.js";
import {
  applySubagentTranscriptEvent,
  hydrateSubagentTranscript,
  type SubagentTranscript,
} from "./app-subagent-transcript.js";

export type SubagentItem = LCodeSessionRunningSubagent | LCodeSessionEndedSubagent;
const EMPTY_DIRECTORY: LCodeSessionSubagentsResult = {
  revision: 0,
  childSessionIds: [],
  running: [],
  ended: { total: 0, items: [] },
};

export function useSubagents(options: TuiOptions) {
  const sessionId = options.getMainSessionId?.();
  const [directory, setDirectory] = React.useState(EMPTY_DIRECTORY);
  const [directoryError, setDirectoryError] = React.useState<string>();
  const [selected, setSelected] = React.useState<SubagentItem>();
  const [transcript, setTranscript] = React.useState<SubagentTranscript>();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const generation = React.useRef(0);
  const selection = React.useRef<SubagentItem | undefined>(undefined);
  const pendingEvents = React.useRef<SessionEvent[] | null>(null);
  const loaded = React.useRef<SubagentTranscript | undefined>(undefined);
  const directoryGeneration = React.useRef(0);
  const directoryRequest = React.useRef<Promise<void> | undefined>(undefined);
  const directoryDirty = React.useRef(false);
  const directoryRef = React.useRef(directory);
  directoryRef.current = directory;

  const refreshDirectory = React.useCallback((): void => {
    if (!options.readSubagents) return;
    directoryDirty.current = true;
    if (directoryRequest.current) return;
    const epoch = directoryGeneration.current;
    const parentId = options.getMainSessionId?.();
    directoryRequest.current = (async () => {
      while (directoryDirty.current && epoch === directoryGeneration.current) {
        directoryDirty.current = false;
        try {
          const snapshot = await options.readSubagents!();
          if (epoch !== directoryGeneration.current || parentId !== options.getMainSessionId?.())
            return;
          setDirectory(snapshot);
          setDirectoryError(undefined);
        } catch (cause) {
          if (epoch === directoryGeneration.current) setDirectoryError(String(cause));
        }
      }
    })().finally(() => {
      if (epoch === directoryGeneration.current) {
        directoryRequest.current = undefined;
        // An event can invalidate the directory after the loop exits but before
        // this continuation runs. Preserve that final refresh request as well.
        if (directoryDirty.current) refreshDirectory();
      }
    });
  }, [options]);

  const back = React.useCallback(() => {
    generation.current += 1;
    selection.current = undefined;
    pendingEvents.current = null;
    loaded.current = undefined;
    setSelected(undefined);
    setTranscript(undefined);
    setLoading(false);
    setError(undefined);
  }, []);

  const open = React.useCallback(
    (item: SubagentItem) => {
      const epoch = ++generation.current;
      const parentId = options.getMainSessionId?.();
      selection.current = item;
      pendingEvents.current = [];
      loaded.current = undefined;
      setSelected(item);
      setTranscript(undefined);
      setLoading(true);
      setError(undefined);
      void (async () => {
        try {
          if (!options.readSubagentTranscript)
            throw new Error("Subagent transcript is unavailable.");
          const snapshot = await options.readSubagentTranscript(item.childSessionId);
          if (epoch !== generation.current || parentId !== options.getMainSessionId?.()) return;
          if (snapshot.sessionId !== item.childSessionId)
            throw new Error("Subagent transcript session mismatch.");
          let next = hydrateSubagentTranscript(snapshot, options.workspaceDirectory);
          for (const event of pendingEvents.current ?? [])
            next = applySubagentTranscriptEvent(next, event, options.workspaceDirectory);
          pendingEvents.current = null;
          loaded.current = next;
          setTranscript(next);
        } catch (cause) {
          if (epoch === generation.current) {
            pendingEvents.current = null;
            setError(String(cause));
          }
        } finally {
          if (epoch === generation.current) setLoading(false);
        }
      })();
    },
    [options],
  );

  React.useEffect(() => {
    directoryGeneration.current += 1;
    directoryRequest.current = undefined;
    setDirectory(EMPTY_DIRECTORY);
    setDirectoryError(undefined);
    back();
    refreshDirectory();
    return () => {
      generation.current += 1;
      directoryGeneration.current += 1;
    };
  }, [sessionId, refreshDirectory, back]);

  const onEvent = React.useCallback(
    (event: SessionEvent) => {
      if (
        changesSubagentDirectory(event) &&
        (event.type !== SessionEventType.ToolCallResult ||
          event.sessionId === options.getMainSessionId?.())
      )
        refreshDirectory();
      if (event.sessionId !== selection.current?.childSessionId) return;
      if (pendingEvents.current) {
        pendingEvents.current.push(event);
        if (pendingEvents.current.length > 4096 && selection.current) open(selection.current);
      } else if (loaded.current) {
        if (event.sequenceNumber > loaded.current.sequenceNumber + 1 && selection.current) {
          open(selection.current);
          return;
        }
        const next = applySubagentTranscriptEvent(
          loaded.current,
          event,
          options.workspaceDirectory,
        );
        if (next !== loaded.current) {
          loaded.current = next;
          setTranscript(next);
        }
      }
    },
    [options, refreshDirectory, open],
  );

  const loadMore = React.useCallback(async () => {
    const cursor = directoryRef.current.ended.nextCursor;
    if (!cursor || !options.readSubagents) return;
    const epoch = directoryGeneration.current;
    try {
      const page = await options.readSubagents({ endedCursor: cursor });
      if (epoch !== directoryGeneration.current) return;
      setDirectory((current) => ({
        ...current,
        ended: {
          ...page.ended,
          items: [
            ...new Map(
              [...current.ended.items, ...page.ended.items].map((item) => [
                item.childSessionId,
                item,
              ]),
            ).values(),
          ],
        },
      }));
    } catch (cause) {
      if (epoch === directoryGeneration.current) setDirectoryError(String(cause));
    }
  }, [options]);

  return {
    directory,
    directoryError,
    selected:
      selected &&
      ([...directory.running, ...directory.ended.items].find(
        (item) => item.childSessionId === selected.childSessionId,
      ) ??
        selected),
    transcript,
    loading,
    error,
    open,
    back,
    onEvent,
    loadMore,
    refreshDirectory,
  };
}

export type SubagentsController = ReturnType<typeof useSubagents>;
