import { WebApiError } from "./api";
import { auth } from "./session";
/** A protected, verified private file. Callers own the short-lived object URL. */
export async function fetchVerifiedBlob(
  path: string,
  expected: { bytes: number; sha256: string },
  signal?: AbortSignal,
): Promise<Blob> {
  return auth.protect(async (_owner, ownerSignal) => {
    const response = await fetch(`/api/v1${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([
        ownerSignal,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(30000),
      ]),
      headers: { "X-Timenook-Web": "1" },
    });
    if (!response.ok) throw new WebApiError(response.status);
    const bytes = await response.arrayBuffer();
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (bytes.byteLength !== expected.bytes || hash !== expected.sha256)
      throw new Error("文件校验失败，请重新读取。");
    return new Blob([bytes], {
      type: response.headers.get("Content-Type") ?? "application/octet-stream",
    });
  });
}
