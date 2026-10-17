import { validateStartupSceneMedia } from "./sceneResource.js";

/** 本机背景资源唯一持久化适配器，不把 Blob 放进 AppSettings 或业务协议。 */
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("lcode-startup-images", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function access(
  mode: IDBTransactionMode,
  image?: Blob,
  id = "current",
): Promise<Blob | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("images", mode);
      const request =
        mode === "readonly"
          ? tx.objectStore("images").get(id)
          : tx.objectStore("images").put(image, id);
      tx.oncomplete = () => resolve(mode === "readonly" ? request.result : undefined);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Image storage failed"));
    });
  } finally {
    db.close();
  }
}
export async function validateStartupSceneImage(image: Blob) {
  await validateStartupSceneMedia(image);
}
export async function saveStartupSceneImage(image: Blob): Promise<string> {
  await validateStartupSceneImage(image);
  // 图片不可变：设置提交失败时不能覆盖旧配置仍在引用的图片。
  const id = crypto.randomUUID();
  await access("readwrite", image, id);
  return id;
}
export async function readStartupSceneImage(id?: string) {
  const image = await access("readonly", undefined, id);
  return image instanceof Blob ? image : undefined;
}
