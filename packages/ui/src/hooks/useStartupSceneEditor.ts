import { useEffect, useRef, useState } from "react";
import {
  getDefaultStartupScene,
  getStartupScene,
  startupSceneSchema,
  sceneTiming,
  type StartupAnimationSettings,
  type StartupScenePreview,
  type StartupSceneSettings,
} from "@lcode/shared/startup-animation";
import { usePlatform } from "./usePlatform.js";

/** 编辑配置与图片都是未提交草稿；仅保存操作写入现有设置 owner。 */
export function useStartupSceneEditor(
  value: StartupAnimationSettings,
  save: (patch: Partial<StartupAnimationSettings>) => Promise<boolean>,
) {
  const platform = usePlatform();
  const [draft, setDraft] = useState<StartupSceneSettings>(
    () => getStartupScene(value) ?? getDefaultStartupScene(value.preset),
  );
  const [image, setImage] = useState<Blob>();
  const [time, setTime] = useState(4.7),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [saved, setSaved] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    player = useRef<StartupScenePreview>(undefined),
    currentTime = useRef(time),
    pending = useRef(false),
    initial = useRef(draft),
    lastUpdate = useRef(0);
  useEffect(() => {
    if (!container.current || !platform.mountStartupScenePreview) return;
    const preview = platform.mountStartupScenePreview(
      container.current,
      initial.current,
      (seconds) => {
        currentTime.current = seconds;
        if (performance.now() - lastUpdate.current > 50) {
          lastUpdate.current = performance.now();
          setTime(seconds);
        }
      },
      value.preset,
    );
    player.current = preview;
    return () => {
      preview.dispose();
      player.current = undefined;
    };
  }, [platform, value.preset]);
  useEffect(() => {
    player.current?.update(draft, image);
    // 改短时长或恢复模板后，先应用配置再定位，避免旧时长夹住新时间或显示越界时钟。
    const seconds = Math.min(currentTime.current, sceneTiming(draft).duration);
    player.current?.seek(seconds);
    currentTime.current = seconds;
    setTime(seconds);
  }, [draft, image]);
  const change = (next: StartupSceneSettings) => {
    setDraft(next);
    setSaved(false);
  };
  const seek = (seconds: number) => {
    player.current?.pause();
    player.current?.seek(seconds);
    currentTime.current = seconds;
    setTime(seconds);
  };
  const importImage = async (file: Blob) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (!platform.validateStartupSceneMedia) throw new Error("Unsupported media validation");
      await platform.validateStartupSceneMedia(file);
      setImage(file);
      change({ ...draft, image: "custom" });
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const commit = async (original = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      let scene = original ? getDefaultStartupScene(value.preset) : startupSceneSchema.parse(draft);
      if (!original && scene.image === "custom" && image) {
        if (!platform.saveStartupSceneImage) throw new Error("Unsupported image storage");
        scene = { ...scene, imageId: await platform.saveStartupSceneImage(image) };
      }
      const scenes = { ...value.scenes };
      if (original && value.preset === "baili") delete scenes.baili;
      else scenes[value.preset] = scene;
      if (!(await save({ scenes, mode: "cinematic" }))) throw new Error("Save failed");
      setDraft(scene);
      setImage(undefined);
      setSaved(true);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return {
    container,
    draft,
    change,
    time,
    duration: sceneTiming(draft).duration,
    busy,
    failed,
    saved,
    seek,
    importImage,
    commit,
    restoreOriginal: () => commit(true),
    play: () => player.current?.play(),
    pause: () => player.current?.pause(),
    preview: () => {
      player.current?.pause();
      platform.previewStartupAnimation?.(
        {
          ...value,
          mode: "cinematic",
          scenes: { ...value.scenes, [value.preset]: startupSceneSchema.parse(draft) },
        },
        image,
      );
    },
    reset: () => {
      setImage(undefined);
      change(getDefaultStartupScene(value.preset));
      seek(4.7);
    },
    useBuiltinImage: () => {
      setImage(undefined);
      change({ ...draft, image: "builtin" });
    },
  };
}
