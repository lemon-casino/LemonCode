import { useEffect, useState } from "react";
import type { WallpaperRecord } from "@/store/wallpaperStorage.js";

/** 自选图片只持有当前 Blob 的对象 URL，切换或卸载时释放。 */
export function useWallpaperMedia(record: WallpaperRecord) {
  const [still, setStill] = useState<{ image: Blob; url: string }>();
  useEffect(() => {
    if (record.source !== "custom" || !record.image) return;
    const url = URL.createObjectURL(record.image);
    setStill({ image: record.image, url });
    return () => URL.revokeObjectURL(url);
  }, [record.source, record.image]);
  return record.source === "custom" && still?.image === record.image ? still?.url : undefined;
}
