import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const required = [
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/api/package.json",
  "apps/api/prisma/schema.prisma",
  "apps/api/prisma/migrations",
  "apps/api/dist",
  "apps/api/runtime",
  "packages/contracts/package.json",
  "packages/contracts/dist",
  "apps/admin/package.json",
  "apps/admin/dist",
  "scripts/print-probe",
  "scripts/release/package.mjs",
  ".cache/print-probe/NotoSansCJKsc-Regular.otf",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function publicReleasePath(path) {
  return !path
    .split(/[\\/]/)
    .some(
      (part) =>
        (part.startsWith(".") && ![".node-version", ".cache"].includes(part)) ||
        [
          "node_modules",
          "dist-test",
          "coverage",
          "id_rsa",
          "id_ed25519",
        ].includes(part) ||
        /\.(?:pem|key|p12|pfx|bak)$/i.test(part),
    );
}
async function filesUnder(root, path) {
  if (!publicReleasePath(path)) throw Error("RELEASE_UNEXPECTED_FILE");
  const info = await lstat(join(root, path));
  if (info.isSymbolicLink()) throw Error("RELEASE_SYMLINK");
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw Error("RELEASE_FILE_TYPE");
  const entries = await readdir(join(root, path));
  if (!entries.length) throw Error("RELEASE_EMPTY_DIRECTORY");
  return (
    await Promise.all(
      entries.map((entry) => filesUnder(root, join(path, entry))),
    )
  ).flat();
}
async function create(root, output, platform) {
  if (platform && platform !== process.platform)
    throw Error("RELEASE_PLATFORM_MISMATCH");
  const commit = git(root, "rev-parse", "HEAD");
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    git(root, "status", "--porcelain", "--untracked-files=no")
  )
    throw Error("RELEASE_SOURCE_NOT_COMMITTED");
  const inside = relative(root, output);
  if (!inside || (!inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
    throw Error("RELEASE_OUTPUT_MUST_BE_OUTSIDE_SOURCE");
  const paths = new Set(
    (await Promise.all(required.map((path) => filesUnder(root, path)))).flat(),
  );
  for (const path of git(root, "ls-files", "-z").split("\0")) {
    if (/^vendor\/vben\/[^/]+\/package\.json$/.test(path)) {
      await filesUnder(root, path);
      paths.add(path);
    }
  }
  const sourcePackage = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const node = (await readFile(join(root, ".node-version"), "utf8")).trim();
  if (
    !/^\d+\.\d+\.\d+$/.test(node) ||
    !/^pnpm@\d+\.\d+\.\d+$/.test(sourcePackage.packageManager)
  )
    throw Error("RELEASE_TOOLCHAIN_NOT_PINNED");
  if (node !== process.versions.node) throw Error("RELEASE_NODE_MISMATCH");
  await mkdir(output, { mode: 0o700 });
  const files = [];
  for (const path of [...paths].sort()) {
    const bytes = await readFile(join(root, path));
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), bytes, { mode: 0o644, flag: "wx" });
    files.push({
      path: path.split(sep).join("/"),
      bytes: bytes.length,
      sha256: digest(bytes),
    });
  }
  const manifest = {
    schemaVersion: 1,
    scope: "candidate",
    commit,
    toolchain: { node, pnpm: sourcePackage.packageManager.slice(5) },
    build: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      openssl: process.versions.openssl,
    },
    files,
  };
  await writeFile(
    join(output, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  await verify(output);
  const archive = output + ".tgz";
  await writeFile(archive, "", { mode: 0o600, flag: "wx" });
  execFileSync("tar", ["-czf", archive, "-C", output, "."], { stdio: "pipe" });
  await writeFile(
    archive + ".sha256",
    `${digest(await readFile(archive))}  ${basename(archive)}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
async function verify(root, platform) {
  if (!(await lstat(join(root, "release-manifest.json"))).isFile())
    throw Error("RELEASE_INVALID_MANIFEST");
  const manifest = JSON.parse(
    await readFile(join(root, "release-manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.scope !== "candidate" ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw Error("RELEASE_INVALID_MANIFEST");
  if (platform && manifest.build?.platform !== platform)
    throw Error("RELEASE_PLATFORM_MISMATCH");
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      isAbsolute(file.path) ||
      seen.has(file.path)
    )
      throw Error("RELEASE_INVALID_PATH");
    seen.add(file.path);
    for (let parent = file.path; parent !== "."; parent = dirname(parent)) {
      if ((await lstat(join(root, parent))).isSymbolicLink())
        throw Error("RELEASE_SYMLINK");
    }
    const bytes = await readFile(join(root, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw Error("RELEASE_INTEGRITY_FAILED");
  }
  const actual = await filesUnder(root, "");
  if (
    actual.length !== seen.size + 1 ||
    actual.some((path) => path !== "release-manifest.json" && !seen.has(path))
  )
    throw Error("RELEASE_INVENTORY_MISMATCH");
  console.log(`Release verified: ${manifest.commit}, ${seen.size} files`);
}
try {
  const [command, ...args] = process.argv.slice(2);
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--root", "--output", "--platform"].includes(args[i]) ||
      !args[i + 1] ||
      flags.has(args[i])
    )
      throw Error("RELEASE_USAGE");
    flags.set(args[i], args[i + 1]);
  }
  const root = resolve(flags.get("--root") ?? process.cwd());
  if (command === "create" && flags.get("--output"))
    await create(root, resolve(flags.get("--output")), flags.get("--platform"));
  else if (command === "verify" && !flags.has("--output"))
    await verify(root, flags.get("--platform"));
  else throw Error("RELEASE_USAGE");
} catch (error) {
  console.error(
    /^RELEASE_[A-Z_]+$/.test(error.message)
      ? error.message
      : "RELEASE_FILES_UNAVAILABLE",
  );
  process.exitCode = 1;
}
