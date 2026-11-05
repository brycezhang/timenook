import { ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

export const INTERNAL_PROFILE_VERSION = "internal-acceptance-v1";
export const INTERNAL_NOTICE_VERSION = "internal-participation-v1";
export const INTERNAL_NOTICE =
  "内部功能验收：本人点击确认并开始时，同意保存讲述与照片、AI整理、向本项目发起人共享，并一起核对整理结果。可以调整用途或撤回；访问和账号关联不代替授权。本项目无付款、实体书生产或公开销售。";
const materials = [
  "originalAudio",
  "originalPhotos",
  "derivedAudio",
  "derivedPhotos",
  "transcripts",
  "confirmedStories",
  "bookPdf",
  "exportPackages",
  "activeData",
  "historicalObjects",
  "backupCopies",
];
export function internalSnapshot(version: string): Prisma.JsonObject {
  if (version !== INTERNAL_PROFILE_VERSION)
    throw new ServiceUnavailableException();
  const quantity = (value: number, unit: string) => ({ value, unit });
  return {
    scope: "internal-acceptance",
    profileVersion: version,
    bookTitle: "内部验收故事书",
    physicalProduction: false,
    admission: {
      scope: "internal-acceptance",
      schemaVersion: 1,
      d02: { service: "lifetime" },
      d03: {
        onlinePlayback: { service: "lifetime" },
        exportRequests: { service: "lifetime" },
        retention: Object.fromEntries(
          materials.map((kind) => [kind, { service: "lifetime" }]),
        ),
      },
      d04: {
        review: { state: "frozen", scope: "internal-acceptance" },
        systemRetriesChargeUserQuota: false,
        userQuotas: {
          recordingPerClip: quantity(120, "seconds"),
          recordingTotal: quantity(1200, "seconds"),
          photos: quantity(10, "count"),
          followUps: quantity(10, "count"),
          storyOrganizations: quantity(10, "count"),
          activeRegenerations: quantity(3, "count"),
        },
        providerBudget: {
          scope: "per_project",
          exhausted: "manual_review",
          asrSubmissions: quantity(20, "count"),
          asrPolls: quantity(200, "count"),
          systemRetries: quantity(2, "count"),
          costCap: quantity(500, "fen"),
        },
      },
      d08: {
        scope: "internal-acceptance",
        noticeVersion: INTERNAL_NOTICE_VERSION,
        notice: INTERNAL_NOTICE,
        commercialApproval: false,
      },
    },
  };
}
