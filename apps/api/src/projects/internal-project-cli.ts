import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  writeFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { readConfig } from "../config";
import { createInternalProject } from "./internal-project";

async function main() {
  const [command, inputFlag, inputPath, outputFlag, outputPath, ...rest] =
    process.argv.slice(2);
  if (
    command !== "create" ||
    inputFlag !== "--input-file" ||
    outputFlag !== "--output-file" ||
    rest.length ||
    !inputPath ||
    !outputPath ||
    !isAbsolute(inputPath) ||
    !isAbsolute(outputPath)
  )
    throw new Error("Invalid command");
  const inputFd = openSync(
    inputPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let input: unknown;
  try {
    const stat = fstatSync(inputFd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 4096
    )
      throw new Error("Input must be owner-only");
    input = JSON.parse(readFileSync(inputFd, "utf8"));
  } finally {
    closeSync(inputFd);
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid input");
  const parent = statSync(dirname(outputPath));
  if (
    !parent.isDirectory() ||
    (parent.mode & 0o077) !== 0 ||
    parent.uid !== process.getuid?.()
  )
    throw new Error("Output directory must be owner-only");
  const outputFd = openSync(
    outputPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let written = false;
  try {
    const result = await createInternalProject(
      readConfig(process.env),
      input as Record<string, unknown>,
    );
    writeFileSync(outputFd, JSON.stringify(result) + "\n");
    written = true;
  } finally {
    closeSync(outputFd);
    if (!written) unlinkSync(outputPath);
  }
}
void main().catch(() => {
  process.stderr.write(
    "Internal project command failed; check configured services and owner-only files\n",
  );
  process.exitCode = 1;
});
