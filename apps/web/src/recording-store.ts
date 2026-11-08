/** A clip and its MP3 are committed together before automatic upload starts. */
export interface LocalRecording {
  clientClipId: string;
  userId: string;
  projectId: string;
  interviewId: string;
  actualQuestionId: string;
  blob: Blob;
  sha256: string;
  durationMs: number;
  createdAt: number;
  serverId?: string;
  sealed?: boolean;
}
export interface RecordingDraft {
  id: string;
  userId: string;
  projectId: string;
  input: {
    clientInterviewId: string;
    expectedPlanRevision: number;
    questionKey?: string;
    selfWritten?: { text: string; intent: string };
  };
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("timenook-web-recordings", 1);
    request.onupgradeneeded = () => {
      const clips = request.result.createObjectStore("clips", {
        keyPath: "clientClipId",
      });
      clips.createIndex("owner", ["userId", "projectId"]);
      request.result.createObjectStore("drafts", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(Error("本机录音空间不可用，请检查浏览器存储权限。"));
  });
}
async function transact<T>(
  store: "clips" | "drafts",
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(Error("本机录音保存未成功，请保留页面后重试。"));
    });
  } finally {
    db.close();
  }
}
export const recordingStore = {
  async clips(userId: string, projectId: string): Promise<LocalRecording[]> {
    return transact("clips", "readonly", (store) =>
      store.index("owner").getAll(IDBKeyRange.only([userId, projectId])),
    );
  },
  async save(clip: LocalRecording) {
    await transact("clips", "readwrite", (store) => store.put(clip));
  },
  async draft(
    id: string,
    userId: string,
    projectId: string,
  ): Promise<RecordingDraft | undefined> {
    const draft: RecordingDraft | undefined = await transact(
      "drafts",
      "readonly",
      (store) => store.get(id),
    );
    return draft?.userId === userId && draft.projectId === projectId
      ? draft
      : undefined;
  },
  async saveDraft(draft: RecordingDraft) {
    await transact("drafts", "readwrite", (store) => store.put(draft));
  },
};
export async function audioDigest(blob: Blob) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
