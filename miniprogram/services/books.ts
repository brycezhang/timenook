import type {
  BookContext,
  BookVersionView,
  PlanDirectory,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
import { paymentKey } from "./payments";
const uuid = (value: string) => /^[a-f0-9-]{36}$/.test(value);
function validProject(id: string) {
  if (!uuid(id)) throw new Error("项目编号无效");
}
function version(value: BookVersionView, projectId: string): BookVersionView {
  if (
    !value ||
    value.projectId !== projectId ||
    !uuid(value.id) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !["queued", "rendering", "ready", "failed", "obsolete"].includes(
      value.state,
    ) ||
    value.snapshot?.schemaVersion !== "t20-v1" ||
    typeof value.snapshot.cover?.title !== "string" ||
    !Array.isArray(value.snapshot.chapters) ||
    !value.task ||
    (value.accessExpiresAt !== null &&
      !Number.isFinite(Date.parse(value.accessExpiresAt)))
  )
    throw new Error("书稿版本无效，请重新查询");
  if (
    value.state === "ready" &&
    (!Number.isSafeInteger(value.pageCount) ||
      value.pageCount! < 1 ||
      !value.pdf ||
      !/^[a-f0-9]{64}$/.test(value.pdf.sha256))
  )
    throw new Error("书稿文件尚未核对完成");
  return value;
}
function context(value: BookContext, projectId: string): BookContext {
  if (
    !value ||
    value.projectId !== projectId ||
    !/^[a-f0-9]{64}$/.test(value.inputHash) ||
    !Array.isArray(value.directory?.chapters) ||
    !Number.isSafeInteger(value.directory.version) ||
    !Array.isArray(value.eligibleStories) ||
    (value.accessExpiresAt !== null &&
      !Number.isFinite(Date.parse(value.accessExpiresAt)))
  )
    throw new Error("书稿状态无效，请重新查询");
  if (value.current) version(value.current, projectId);
  return value;
}
export const bookClient = {
  async read(projectId: string) {
    validProject(projectId);
    return context(
      await sessionClient.request<BookContext>(`/projects/${projectId}/book`),
      projectId,
    );
  },
  async readVersion(projectId: string, id: string) {
    validProject(projectId);
    if (!uuid(id)) throw new Error("书稿编号无效");
    const result = version(
      await sessionClient.request<BookVersionView>(
        `/projects/${projectId}/book/versions/${id}`,
      ),
      projectId,
    );
    if (result.id !== id) throw new Error("书稿版本不一致，请重新查询");
    return result;
  },
  async generate(projectId: string, inputHash: string, key: string) {
    validProject(projectId);
    return version(
      await sessionClient.request<BookVersionView>(
        `/projects/${projectId}/book/versions`,
        { key, data: { expectedInputHash: inputHash } },
      ),
      projectId,
    );
  },
  async retry(projectId: string, id: string, key: string) {
    validProject(projectId);
    if (!uuid(id)) throw new Error("书稿编号无效");
    return version(
      await sessionClient.request<BookVersionView>(
        `/projects/${projectId}/book/versions/${id}/retry`,
        { key, data: {} },
      ),
      projectId,
    );
  },
  async reviseDirectory(
    projectId: string,
    expectedVersion: number,
    chapters: PlanDirectory["chapters"],
  ) {
    validProject(projectId);
    return context(
      await sessionClient.request<BookContext>(
        `/projects/${projectId}/book/directory`,
        { key: paymentKey(), data: { expectedVersion, chapters } },
      ),
      projectId,
    );
  },
};
