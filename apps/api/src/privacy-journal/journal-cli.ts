import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { PrivacyJournal, PrivacyJournalError } from "./privacy-journal";

function inside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}
async function repository(): Promise<string | undefined> {
  let path = __dirname;
  while (dirname(path) !== path) {
    try {
      await lstat(resolve(path, ".git"));
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    path = dirname(path);
  }
  return undefined;
}
async function keyFromFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 100
    ) {
      throw new PrivacyJournalError("key file is not private");
    }
    return (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const allowed =
    command === "bootstrap"
      ? ["--root", "--key-file", "--database-id"]
      : ["--root", "--key-file"];
  if (
    !["bootstrap", "inspect"].includes(command) ||
    args.length !== allowed.length * 2
  ) {
    throw new PrivacyJournalError(
      "usage: bootstrap|inspect --root ABSOLUTE --key-file ABSOLUTE [--database-id ID]",
    );
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    if (
      !allowed.includes(args[index]) ||
      options[args[index]] ||
      !args[index + 1]
    )
      throw new PrivacyJournalError("invalid CLI options");
    options[args[index]] = args[index + 1];
  }
  if (!isAbsolute(options["--root"]) || !isAbsolute(options["--key-file"]))
    throw new PrivacyJournalError("absolute paths required");
  // Resolve existing parents so symlink aliases cannot place the secret inside source/release files.
  const rootInput = resolve(options["--root"]);
  const keyInput = resolve(options["--key-file"]);
  const root = resolve(await realpath(dirname(rootInput)), basename(rootInput));
  const keyFile = resolve(
    await realpath(dirname(keyInput)),
    basename(keyInput),
  );
  // Release packages may omit .git; their apps/api/dist location still identifies the release root.
  const repo = (await repository()) ?? resolve(__dirname, "../../../..");
  if (inside(keyFile, root) || inside(root, repo) || inside(keyFile, repo)) {
    throw new PrivacyJournalError(
      "source and key must be independent of repository/release files and each other",
    );
  }
  if (command === "bootstrap") {
    const key = randomBytes(32).toString("base64");
    const file = await open(keyFile, "wx", 0o600);
    try {
      await file.writeFile(`${key}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(
      dirname(keyFile),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const authority = await PrivacyJournal.bootstrap(
      { root, key },
      { databaseId: options["--database-id"] },
    );
    process.stdout.write(`${JSON.stringify({ authority })}\n`);
  } else {
    const { events: _events, ...metadata } = await new PrivacyJournal({
      root,
      key: await keyFromFile(keyFile),
    }).snapshot();
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  }
}
void main().catch((error) => {
  process.stderr.write(
    `${error instanceof PrivacyJournalError ? error.message : "Privacy journal: maintenance failed"}\n`,
  );
  process.exitCode = 1;
});
