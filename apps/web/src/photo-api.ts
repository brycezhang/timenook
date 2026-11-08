import type {
  PhotoCollection,
  PhotoMaterials,
  ProbeUploadForm,
  StoryPhoto,
} from "../../../packages/contracts/src";
import { memberRequest, projectApi } from "./project-api";
import { auth } from "./session";
import { WebApiError } from "./api";
import { audioDigest } from "./recording-store";

const base = (projectId: string, interviewId: string) =>
  `/projects/${encodeURIComponent(projectId)}/interviews/${encodeURIComponent(interviewId)}/photos`;
export interface PendingPhoto {
  id: string;
  file: File;
  sha256: string;
  serverId?: string;
  state: "uploading" | "failed";
  error: string;
}
export const photoApi = {
  list: (projectId: string, interviewId: string) =>
    memberRequest<PhotoCollection>(base(projectId, interviewId)),
  snapshot: (projectId: string, interviewId: string, snapshotId: string) =>
    memberRequest<PhotoMaterials | null>(
      `${base(projectId, interviewId)}/materials/${encodeURIComponent(snapshotId)}`,
    ),
  revise: (
    projectId: string,
    interviewId: string,
    snapshot: PhotoMaterials,
    entries: { photoId: string; caption: string }[],
  ) =>
    memberRequest<PhotoMaterials>(
      `${base(projectId, interviewId)}/materials`,
      {
        expectedRevision: snapshot.revision,
        entries,
      },
      crypto.randomUUID(),
    ),
  release: (projectId: string, interviewId: string, photoId: string) =>
    memberRequest<StoryPhoto>(
      `${base(projectId, interviewId)}/${photoId}/release`,
      {},
      crypto.randomUUID(),
    ),
  async upload(
    projectId: string,
    interviewId: string,
    photo: PendingPhoto,
    current: () => boolean,
  ) {
    const path = base(projectId, interviewId);
    let remote = photo.serverId
      ? await memberRequest<StoryPhoto>(
          `${path}/${photo.serverId}/status`,
          {},
          crypto.randomUUID(),
        )
      : await memberRequest<StoryPhoto>(
          path,
          {
            clientPhotoId: photo.id,
            bytes: photo.file.size,
            sha256: photo.sha256,
          },
          photo.id,
        );
    const verify = () => {
      if (!current()) throw new DOMException("Upload superseded", "AbortError");
      if (
        remote.projectId !== projectId ||
        remote.interviewId !== interviewId ||
        remote.clientPhotoId !== photo.id ||
        remote.bytes !== photo.file.size ||
        remote.sha256 !== photo.sha256 ||
        (photo.serverId && photo.serverId !== remote.id)
      )
        throw Error("照片上传结果不匹配，请重新读取。");
    };
    verify();
    photo.serverId = remote.id;
    if (remote.state === "released")
      throw Error("这张照片的上传已取消，请重新选择照片。");
    if (remote.state !== "sealed") {
      const form = await memberRequest<ProbeUploadForm>(
        `${path}/${remote.id}/upload`,
        {},
        crypto.randomUUID(),
      );
      verify();
      await uploadPhoto(form, photo.file);
      verify();
      remote = await memberRequest<StoryPhoto>(
        `${path}/${remote.id}/seal`,
        {},
        crypto.randomUUID(),
      );
    }
    verify();
    const original = remote.assets.find((asset) => asset.kind === "original");
    if (
      remote.state !== "sealed" ||
      !original ||
      original.bytes !== photo.file.size ||
      original.sha256 !== photo.sha256 ||
      !remote.assets.some((asset) => asset.kind === "preview")
    )
      throw Error("照片保存尚未确认，请重试。");
    return remote;
  },
  async attach(projectId: string, storyId: string, snapshot: PhotoMaterials) {
    const story = await projectApi.story(projectId, storyId);
    const revision = story.revision;
    if (
      !revision ||
      revision.photoSnapshotId === snapshot.id ||
      revision.photoSnapshot?.id === snapshot.id
    )
      return;
    return memberRequest(
      `/projects/${projectId}/stories/${storyId}/revisions`,
      {
        expectedVersion: story.version,
        baseRevisionId: revision.id,
        title: revision.title,
        theme: revision.theme,
        paragraphs: revision.paragraphs,
        notes: revision.notes ?? [],
        reviewResolutions: revision.reviewResolutions ?? [],
        photoSnapshotId: snapshot.id,
      },
      crypto.randomUUID(),
    );
  },
};
async function uploadPhoto(form: ProbeUploadForm, blob: Blob) {
  const local =
    form.storage === "local-simulator" && form.url === "/v1/photos/objects";
  const cloud =
    form.storage === "oss" &&
    /^https:\/\/[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(form.url);
  if (
    (!local && !cloud) ||
    !Number.isFinite(Date.parse(form.expiresAt)) ||
    Date.parse(form.expiresAt) <= Date.now()
  )
    throw Error("照片上传凭据已失效，请重试。");
  const body = new FormData();
  for (const [key, value] of Object.entries(form.fields))
    body.append(key, value);
  body.append("file", blob, "photo.bin");
  return auth.protect(async (owner, signal) => {
    const response = await fetch(local ? "/api/v1/photos/objects" : form.url, {
      method: "POST",
      body,
      credentials: local ? "same-origin" : "omit",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      headers: local
        ? { "X-Timenook-Web": "1", "X-CSRF-Token": owner.csrfToken }
        : {},
    }).catch(() => {
      throw Error("照片上传未成功，请重试；当前页面仍保留所选照片。");
    });
    if (!response.ok)
      throw new WebApiError(response.status, "照片上传未成功，请重试。");
  });
}
export async function pendingPhoto(file: File): Promise<PendingPhoto> {
  if (!file.size || file.size > 16777216)
    throw Error("请选择不超过 16 MB 的照片。");
  if (
    !/\.(jpe?g|png|heic|heif)$/i.test(file.name) &&
    !/^image\/(jpeg|png|heic|heif)$/.test(file.type)
  )
    throw Error("请选择 JPEG、PNG 或 HEIC 照片。");
  return {
    id: crypto.randomUUID(),
    file,
    sha256: await audioDigest(file),
    state: "uploading",
    error: "",
  };
}
