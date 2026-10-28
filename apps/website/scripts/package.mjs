import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const destination = process.argv[2];
if (!destination)
  throw new Error("Usage: pnpm package:website NEW_OUTPUT_DIRECTORY");
const output = resolve(destination);
const site = fileURLToPath(new URL("../dist/", import.meta.url));
await access(join(site, "index.html"));
// A new output directory prevents overwriting an existing release.
await mkdir(output, { recursive: false });
const archive = join(output, "website.tgz");
execFileSync("tar", ["-czf", archive, "-C", site, "."]);
const sha256 = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: site,
  encoding: "utf8",
}).trim();
await writeFile(join(output, "website.tgz.sha256"), `${sha256}  website.tgz\n`);
await writeFile(
  join(output, "website-release.json"),
  JSON.stringify(
    {
      application: "timenook-website",
      revision,
      workingTreeDirty:
        execFileSync("git", ["status", "--porcelain"], {
          cwd: site,
          encoding: "utf8",
        }).trim().length > 0,
      previewOnly: true,
      archive: "website.tgz",
      sha256,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Website preview archive: ${archive}`);
