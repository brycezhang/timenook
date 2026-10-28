export type DeletionLayer =
  | "active_database"
  | "active_files"
  | "cache"
  | "object_history"
  | "backup"
  | "supplier";
export interface DeletionItemView {
  id: string;
  category: string;
  layer: DeletionLayer;
  state: "pending" | "running" | "completed" | "awaiting_evidence";
  deadline: string | null;
  completedAt: string | null;
  reason: string | null;
  evidenceRef: string | null;
}
export interface DeletionStatus {
  projectId: string;
  onlineAccessStopped: boolean;
  permanentProjectDeletion: boolean;
  accessEpoch: number;
  changes: {
    id: string;
    requestId: string | null;
    trigger: "verified_request" | "retention_expiry";
    categories: string[];
    effectiveAt: string;
    createdAt: string;
    items: DeletionItemView[];
  }[];
  boundary: string;
}
export const DELETION_CATEGORY_LABELS: Record<string, string> = {
  all: "全部项目资料",
  activeData: "活动资料与个人安排",
  originalAudio: "原始录音",
  originalPhotos: "原始照片",
  derivedAudio: "衍生音频",
  derivedPhotos: "衍生照片",
  transcripts: "原始转录",
  confirmedStories: "确认稿与历史版本",
  bookPdf: "书稿与PDF",
  exportPackages: "完整导出包",
  historicalObjects: "对象历史版本",
  backupCopies: "备份副本",
  supplierCopies: "供应商副本",
};
export const DELETION_LAYER_LABELS: Record<DeletionLayer, string> = {
  active_database: "活动数据库",
  active_files: "活动文件与临时目录",
  cache: "受控缓存",
  object_history: "对象历史版本",
  backup: "备份副本",
  supplier: "供应商副本",
};
