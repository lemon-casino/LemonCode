import { create } from "zustand";
import {
  isWallpaperImage,
  WALLPAPER_SOURCES,
  wallpaperStorage,
  decodeWallpaperImage,
  type WallpaperRecord,
  type WallpaperSource,
  type WallpaperStorage,
} from "./wallpaperStorage.js";
export type { WallpaperRecord } from "./wallpaperStorage.js";

interface WallpaperState {
  record: WallpaperRecord;
  initialized: boolean;
  busy: boolean;
  failed: boolean;
  initialize(): Promise<void>;
  select(source: WallpaperSource): Promise<boolean>;
  importImage(image: Blob): Promise<boolean>;
}

/** 本机装饰偏好不进入广播设置或 Host；一条串行写入路径持有图片与选择。 */
export function createWallpaperStore(
  storage: WallpaperStorage,
  decode: (image: Blob) => Promise<void> = decodeWallpaperImage,
) {
  let initialization: Promise<void> | undefined;
  let queue = Promise.resolve();
  let pending = 0;
  return create<WallpaperState>((set, get) => {
    const persist = (
      change: (record: WallpaperRecord) => WallpaperRecord | Promise<WallpaperRecord>,
    ) => {
      pending++;
      set({ busy: true, failed: false });
      const initialized = get().initialize();
      const result = queue.then(async () => {
        await initialized;
        try {
          const record = await change(get().record);
          if (
            !WALLPAPER_SOURCES.includes(record.source) ||
            (record.source === "custom" && !record.image) ||
            (record.image && !isWallpaperImage(record.image))
          )
            throw new Error("Invalid wallpaper");
          await storage.write(record);
          set({ record, failed: false });
          return true;
        } catch {
          set({ failed: true });
          return false;
        } finally {
          pending--;
          set({ busy: pending > 0 });
        }
      });
      queue = result.then(() => {});
      return result;
    };
    return {
      record: { source: "none" },
      initialized: false,
      busy: false,
      failed: false,
      initialize() {
        initialization ??= storage
          .read()
          .then((record) => {
            // 移除的来源只投影为关闭，保留有效自选图；后续保存仍经过唯一串行写入路径。
            if (record && !WALLPAPER_SOURCES.includes(record.source))
              record = { ...record, source: "none" };
            if (
              record &&
              WALLPAPER_SOURCES.includes(record.source) &&
              (!record.image || (record.image instanceof Blob && isWallpaperImage(record.image))) &&
              (record.source !== "custom" || record.image)
            )
              set({ record });
          })
          .catch(() => {
            set({ failed: true });
          })
          .finally(() => {
            set({ initialized: true });
          });
        return initialization;
      },
      select: (source) => persist((record) => ({ ...record, source })),
      // 图片解码也进入同一 admission：切换/关闭设置后，慢解码不能覆盖更新的选择。
      importImage: (image) =>
        persist(async () => {
          if (!isWallpaperImage(image)) throw new Error("Invalid image");
          await decode(image);
          return { source: "custom", image };
        }),
    };
  });
}

export const useWallpaperStore = createWallpaperStore(wallpaperStorage, decodeWallpaperImage);
