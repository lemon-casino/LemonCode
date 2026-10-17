import { useEffect, useRef, useState, type DragEvent } from "react";
import type { IServiceAccessor } from "@lcode/services";
import { resolveDroppedLocalProjectFolders } from "@/createProjectFolderDrop.js";
import { usePlatform } from "./usePlatform.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function useProjectFolderDrop({
  enabled,
  busy,
  services,
  onFolders,
  onError,
}: {
  enabled: boolean;
  busy: boolean;
  services: IServiceAccessor;
  onFolders(paths: string[]): void | Promise<void>;
  onError(message: string | null): void;
}) {
  const platform = usePlatform();
  const { intl } = useLCodeIntl();
  const [dragging, setDragging] = useState(false);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const callbacks = useRef({ onFolders, onError });
  callbacks.current = { onFolders, onError };
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setDragging(false);
    setChecking(false);
    return () => {
      generation.current++;
    };
  }, [enabled, services]);
  const canDrop = enabled && Boolean(platform.canSelectFilePath && platform.getPathForFile);
  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    if (!canDrop || busy || pending.current) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const token = generation.current;
    pending.current = true;
    setChecking(true);
    callbacks.current.onError(null);
    try {
      const resolved = await resolveDroppedLocalProjectFolders(
        files,
        (file) => platform.getPathForFile?.(file) ?? null,
        async (path) => (await services.fileService.stat({ path })).type,
      );
      // 中文依据：关闭弹框或切换来源后，旧校验结果不能追加到另一个项目草稿。
      if (token !== generation.current) return;
      if (resolved.folderPaths.length) await callbacks.current.onFolders(resolved.folderPaths);
      if (token === generation.current && resolved.rejectedCount)
        callbacks.current.onError(
          intl.formatMessage({ id: "chat.empty.createProject.dropInvalid" }),
        );
    } catch (error) {
      if (token === generation.current)
        callbacks.current.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === generation.current) {
        pending.current = false;
        setChecking(false);
      }
    }
  };
  return {
    canDrop,
    dragging,
    checking,
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      void onDrop(event);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = canDrop && !busy && !pending.current ? "copy" : "none";
      if (canDrop && !busy && !pending.current) setDragging(true);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
  };
}
