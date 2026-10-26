import type {
  FirstCopyAddress,
  FirstCopyBinding,
  FirstCopyContext,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
const uuid = (value: string) => /^[a-f0-9-]{36}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function context(value: FirstCopyContext, projectId: string): FirstCopyContext {
  if (
    !value ||
    value.projectId !== projectId ||
    !["initiator", "narrator"].includes(value.role) ||
    !value.address ||
    !Number.isSafeInteger(value.address.version) ||
    (value.address.hash !== null && !hash(value.address.hash)) ||
    !value.confirmations ||
    typeof value.confirmations.narrator !== "boolean" ||
    typeof value.confirmations.initiator !== "boolean" ||
    !value.payment ||
    value.payment.paidAmountFen !== 99900 ||
    value.payment.currency !== "CNY" ||
    value.payment.copies !== 1 ||
    value.payment.amountDueFen !== 0 ||
    !Array.isArray(value.shipping?.terms) ||
    !Array.isArray(value.shipping.regionCodes) ||
    !Array.isArray(value.blockers) ||
    typeof value.canSubmit !== "boolean" ||
    typeof value.canReviseProduction !== "boolean" ||
    !value.creation ||
    (value.accessExpiresAt !== null &&
      !Number.isFinite(Date.parse(value.accessExpiresAt))) ||
    (value.creation.expiresAt !== null &&
      !Number.isFinite(Date.parse(value.creation.expiresAt))) ||
    (value.book &&
      (value.book.projectId !== projectId ||
        !uuid(value.book.id) ||
        !hash(value.book.snapshotHash) ||
        (value.book.state === "ready" &&
          (!value.book.pdf || !hash(value.book.pdf.sha256)))))
  )
    throw new Error("首本制作状态无效，请重新查询");
  return value;
}
export const firstCopyClient = {
  async read(projectId: string) {
    if (!uuid(projectId)) throw new Error("项目编号无效");
    return context(
      await sessionClient.request<FirstCopyContext>(
        `/projects/${projectId}/first-copy`,
      ),
      projectId,
    );
  },
  async saveAddress(
    projectId: string,
    expectedVersion: number,
    value: FirstCopyAddress,
    key: string,
  ) {
    if (!uuid(projectId)) throw new Error("项目编号无效");
    return context(
      await sessionClient.request<FirstCopyContext>(
        `/projects/${projectId}/first-copy/address`,
        { key, data: { expectedVersion, ...value } },
      ),
      projectId,
    );
  },
  async confirm(
    projectId: string,
    input: {
      role: "narrator" | "initiator";
      bookVersionId: string;
      snapshotHash: string;
      pdfHash: string;
      addressHash?: string;
      noticeVersion: string;
      evidenceRef: string;
      assistedSessionId?: string;
    },
    key: string,
  ) {
    if (!uuid(projectId)) throw new Error("项目编号无效");
    return context(
      await sessionClient.request<FirstCopyContext>(
        `/projects/${projectId}/first-copy/confirmations`,
        { key, data: input },
      ),
      projectId,
    );
  },
  async submit(projectId: string, binding: FirstCopyBinding, key: string) {
    if (!uuid(projectId)) throw new Error("项目编号无效");
    return context(
      await sessionClient.request<FirstCopyContext>(
        `/projects/${projectId}/first-copy/submit`,
        { key, data: { ...binding } },
      ),
      projectId,
    );
  },
  async expiryReview(projectId: string, key: string) {
    if (!uuid(projectId)) throw new Error("项目编号无效");
    return context(
      await sessionClient.request<FirstCopyContext>(
        `/projects/${projectId}/first-copy/expiry-review`,
        { key, data: {} },
      ),
      projectId,
    );
  },
};
