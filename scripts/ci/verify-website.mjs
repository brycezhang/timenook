import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyWebsite(directory, sha) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
    throw Error("Invalid website candidate SHA");
  const read = (name) => {
    const file = resolve(directory, name);
    if (!lstatSync(file).isFile())
      throw Error("Website candidate files must be regular files");
    return readFileSync(file);
  };
  const archive = read("website.tgz");
  const checksum = read("website.tgz.sha256").toString("utf8");
  const manifest = JSON.parse(read("website-release.json").toString("utf8"));
  const match = /^([a-f0-9]{64})  website\.tgz\n?$/.exec(checksum);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (!archive.length || !match || match[1] !== digest)
    throw Error("Website candidate checksum failed");
  if (
    manifest.application !== "timenook-website" ||
    manifest.revision !== sha ||
    manifest.workingTreeDirty !== false ||
    manifest.previewOnly !== true ||
    manifest.archive !== "website.tgz" ||
    manifest.sha256 !== digest
  )
    throw Error("Website candidate metadata failed");
  return { revision: sha, sha256: digest };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [directory, sha, ...extra] = process.argv.slice(2);
    if (!directory || !sha || extra.length)
      throw Error("Invalid website verifier arguments");
    verifyWebsite(resolve(directory), sha);
    console.log(`Website candidate verified: ${sha}`);
  } catch {
    console.error("Website candidate verification failed");
    process.exitCode = 1;
  }
}
