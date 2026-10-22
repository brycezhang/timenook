import type { ProbeUploadForm } from "@timenook/contracts";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, dirname } from "node:path";
export const PROBE_OBJECTS = Symbol("PROBE_OBJECTS");
/** External object-storage seam. Only the explicit local simulator is implemented in T02. */
export interface ProbeObjects {
  asrSource?(
    key: string,
    fetchWindowSeconds: number,
  ): Promise<import("./ai-providers").AsrSource>;
  uploadForm?(
    key: string,
    bytes: number,
    expiresAt: Date,
  ): Promise<ProbeUploadForm>;
  put(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  copy(source: string, target: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export class LocalProbeObjects implements ProbeObjects {
  constructor(private readonly root: string) {}
  private path(key: string) {
    if (!/^(staging|sealed)\/[0-9a-f-]{36}\.mp3$/.test(key))
      throw new Error("Invalid object key");
    return join(this.root, "objects", key);
  }
  async put(key: string, bytes: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  async read(key: string) {
    const path = this.path(key);
    if ((await stat(path)).size > 2097152) throw new Error("Object too large");
    return readFile(path);
  }
  async copy(source: string, target: string) {
    const path = this.path(target);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await copyFile(this.path(source), path);
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}
