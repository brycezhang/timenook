export interface StoryPhoto {
  id: string;
  projectId: string;
  interviewId: string;
  actualQuestionId: string;
  clientPhotoId: string;
  bytes: number;
  sha256: string;
  state: "pending" | "sealed" | "released";
  storage: "local-simulator" | "oss";
  lowResolution: boolean | null;
  orientedPixels: { width: number; height: number } | null;
  assets: {
    id: string;
    kind: string;
    parentId: string | null;
    processingVersion: string;
    bytes: number;
    sha256: string;
    mime: string;
    width: number;
    height: number;
  }[];
}
export interface PhotoMaterials {
  id: string;
  projectId: string;
  interviewId: string;
  revision: number;
  hash: string;
  entries: {
    photoId: string;
    caption: string;
    assets: {
      id: string;
      kind: string;
      sha256: string;
      processingVersion: string;
      bytes: number;
      mime: string;
      width: number;
      height: number;
    }[];
  }[];
}
export interface PhotoCollection {
  photos: StoryPhoto[];
  snapshot: PhotoMaterials | null;
  usage: { reservedCount: number; consumedCount: number };
}
