import { createMp3Recorder } from "./browser-recorder";
// Browser-only adapters. The shipping mini program uses native wx APIs.
const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("timenook-media", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const temporary = new Map<string, Blob>();
export function temporaryFile(blob: Blob) {
  const id = URL.createObjectURL(blob);
  temporary.set(id, blob);
  return id;
}
export async function removeBlob(path: string) {
  if (temporary.delete(path)) {
    URL.revokeObjectURL(path);
    return;
  }
  if (path.startsWith("blob:")) {
    URL.revokeObjectURL(path);
    return;
  }
  if (!path.startsWith("local-media:") && !path.startsWith("local-data:"))
    throw Error("Invalid local file");
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").delete(path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function saveBlob(path: string) {
  const blob = temporary.get(path);
  if (!blob) throw Error("临时文件已失效");
  const id = "local-media:" + crypto.randomUUID();
  await writeBlob(id, blob);
  temporary.delete(path);
  URL.revokeObjectURL(path);
  return id;
}
export async function writeBlob(id: string, blob: Blob) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("files", "readwrite");
    t.objectStore("files").put(blob, id);
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}
export async function resolveBlob(path: string) {
  if (!path.startsWith("local-media:") && !path.startsWith("local-data:"))
    return path;
  const db = await openDb();
  const blob = await new Promise<Blob>((resolve, reject) => {
    const r = db.transaction("files").objectStore("files").get(path);
    r.onsuccess = () =>
      r.result ? resolve(r.result) : reject(Error("文件不存在"));
    r.onerror = () => reject(r.error);
  });
  db.close();
  return URL.createObjectURL(blob);
}
export function createRecorder() {
  return createMp3Recorder(temporaryFile);
}
export function createAudio() {
  const audio = new Audio();
  let src = "",
    token = 0;
  const api: any = {
    set src(v: string) {
      if (src !== v) {
        src = v;
        token++;
      }
    },
    get src() {
      return src;
    },
    get currentTime() {
      return audio.currentTime;
    },
    get duration() {
      return Number.isFinite(audio.duration) ? audio.duration : 0;
    },
    get paused() {
      return audio.paused;
    },
    async play() {
      const t = ++token;
      try {
        const resolved = await resolveBlob(src);
        if (t !== token) return;
        if (audio.dataset.source !== src) {
          audio.src = resolved;
          audio.dataset.source = src;
        }
        await audio.play();
      } catch {
        if (t === token) audio.dispatchEvent(new Event("error"));
      }
    },
    pause() {
      token++;
      audio.pause();
    },
    stop() {
      token++;
      audio.pause();
      audio.currentTime = 0;
    },
    destroy() {
      token++;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
  };
  for (const [method, event] of [
    ["onPlay", "play"],
    ["onEnded", "ended"],
    ["onTimeUpdate", "timeupdate"],
    ["onEnded", "ended"],
    ["onError", "error"],
  ])
    api[method] = (fn: Function) => audio.addEventListener(event, () => fn());
  return api;
}
