import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
export type ExportFile = {
  path: string;
  bytes: Buffer;
  provenance: string;
  source: unknown;
};
const MAX_BYTES = 134217728;
export const hashBytes = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
/** Bounded ZIP STORE, UTF-8 paths; ordinary ZIP readers need no platform service. */
export function exportZip(files: ExportFile[], metadata: object) {
  if (
    files.length > 512 ||
    files.reduce((n, f) => n + f.bytes.length, 0) > MAX_BYTES
  )
    throw new Error("EXPORT_LIMIT_REQUIRES_CARE");
  const manifest = {
    format: "timenook-complete-export-v1",
    ...metadata,
    files: files.map((f) => ({
      path: f.path,
      bytes: f.bytes.length,
      sha256: hashBytes(f.bytes),
      provenance: f.provenance,
      source: f.source,
    })),
  };
  const entries = [
    ...files,
    {
      path: "manifest.json",
      bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    },
  ];
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  const paths = new Set<string>();
  for (const f of entries) {
    if (
      !/^[A-Za-z0-9_./-]+$/.test(f.path) ||
      f.path.startsWith("/") ||
      f.path.split("/").some((p) => !p || p === "." || p === "..") ||
      paths.has(f.path)
    )
      throw new Error("EXPORT_INVALID_PATH");
    paths.add(f.path);
    const name = Buffer.from(f.path),
      crc = crc32(f.bytes),
      header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(f.bytes.length, 18);
    header.writeUInt32LE(f.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(f.bytes.length, 20);
    directory.writeUInt32LE(f.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, f.bytes);
    central.push(directory, name);
    offset += header.length + name.length + f.bytes.length;
  }
  const centralBytes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...local, centralBytes, end]), manifest };
}
