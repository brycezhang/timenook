import { execFileSync, spawnSync } from "node:child_process";
import { posix } from "node:path";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const docsPath = (path) =>
  /^(?:docs\/.*|apps\/[^/]+\/README|README|CONTEXT|GLOSSARY|AGENTS)\.md$/.test(
    path,
  );
function changed(base, head) {
  // Disable rename detection so a code file renamed to .md still includes its old path.
  return git("diff", "--no-renames", "--name-only", "-z", base, head, "--")
    .split("\0")
    .filter(Boolean);
}
function tree(ref) {
  return new Map(
    git("ls-tree", "-r", "-z", ref)
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("\t");
        const metadata = entry.slice(0, separator);
        const path = entry.slice(separator + 1);
        return [path, metadata.split(" ")[0]];
      }),
  );
}
function classify(base, head) {
  const paths = changed(base, head);
  const before = tree(base),
    after = tree(head);
  return paths.length &&
    paths.every(
      (path) =>
        docsPath(path) &&
        [before.get(path), after.get(path)].every(
          (mode) => mode === undefined || mode === "100644",
        ),
    )
    ? "docs"
    : "full";
}
function links(markdown) {
  const text = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]+`/g, "");
  return [
    ...text.matchAll(
      /!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g,
    ),
    ...text.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm),
  ].map((match) => match[1].replace(/^<|>$/g, ""));
}
function localTarget(file, link) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(link)) return null;
  const target = decodeURIComponent(link.split(/[?#]/)[0]);
  if (!target) return null;
  return posix.normalize(posix.join(posix.dirname(file), target));
}
function checkDocs(base, head) {
  git("diff", "--check", base, head, "--");
  const before = tree(base),
    after = tree(head);
  const read = (ref, file) => git("show", `${ref}:${file}`);
  const exists = (entries, path) =>
    entries.has(path) ||
    [...entries.keys()].some((file) => file.startsWith(`${path}/`));
  const errors = [];
  let baseline = 0;
  for (const [file, mode] of after) {
    if (!docsPath(file) || mode !== "100644") continue;
    const previous = new Set(before.has(file) ? links(read(base, file)) : []);
    for (const link of links(read(head, file))) {
      const target = localTarget(file, link);
      if (!target || exists(after, target)) continue;
      if (
        spawnSync("git", ["check-ignore", "--quiet", "--", target]).status === 0
      )
        continue;
      if (previous.has(link) && !exists(before, target)) {
        baseline++;
        continue;
      }
      errors.push(`${file}: missing local link ${link}`);
    }
  }
  for (const manifest of [...after.keys()].filter((path) =>
    /^docs\/delivery\/[^/]+\/tickets\.json$/.test(path),
  )) {
    const tickets = JSON.parse(read(head, manifest));
    if (!Array.isArray(tickets) || tickets.length === 0)
      throw new Error(`${manifest}: expected non-empty ticket list`);
    const ids = new Set(tickets.map((ticket) => ticket.id));
    if (ids.size !== tickets.length)
      errors.push(`${manifest}: duplicate ticket IDs`);
    for (const ticket of tickets) {
      const { id, file, blockedBy, issueUrl } = ticket;
      if (
        !/^T\d{2}$/.test(id) ||
        !/^tickets\/[^/]+\.md$/.test(file) ||
        !Array.isArray(blockedBy)
      ) {
        errors.push(`${manifest}: invalid ticket structure`);
        continue;
      }
      const path = posix.join(posix.dirname(manifest), file);
      if (!after.has(path)) {
        errors.push(`${id}: missing ${path}`);
        continue;
      }
      const content = read(head, path);
      if (!content.startsWith(`# ${id} · `))
        errors.push(`${id}: missing matching title`);
      if (
        typeof issueUrl !== "string" ||
        !/^https:\/\/github\.com\/brycezhang\/timenook\/issues\/\d+$/.test(
          issueUrl,
        ) ||
        !content.includes(issueUrl)
      )
        errors.push(`${id}: missing matching GitHub issue`);
      for (const section of ["交付结果", "验收条件", "测试决策", "阻塞依赖"]) {
        if (!content.includes(`\n## ${section}\n`))
          errors.push(`${id}: missing ${section}`);
      }
      if (!/^- \[[ x]\] .+/m.test(content))
        errors.push(`${id}: missing acceptance checklist`);
      for (const dependency of blockedBy)
        if (!ids.has(dependency) || dependency === id)
          errors.push(`${id}: invalid blocker ${dependency}`);
      const dependencySection =
        content.split("\n## 阻塞依赖\n")[1]?.split("\n## ")[0] ?? "";
      const documented = [...dependencySection.matchAll(/\[(T\d{2})[ ·]/g)].map(
        (match) => match[1],
      );
      if (
        JSON.stringify([...documented].sort()) !==
        JSON.stringify([...blockedBy].sort())
      )
        errors.push(`${id}: blockers differ from tickets.json`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `Documentation links and diff passed; ${baseline} pre-existing unresolved links unchanged.`,
  );
}
try {
  const [command, base, head] = process.argv.slice(2);
  if (command === "gate") {
    const needs = JSON.parse(process.env.CHECK_NEEDS || "{}");
    const mode = needs.changes?.outputs?.mode;
    if (
      needs.changes?.result !== "success" ||
      !["docs", "full"].includes(mode) ||
      needs[mode]?.result !== "success" ||
      needs[mode === "docs" ? "full" : "docs"]?.result !== "skipped"
    )
      throw new Error(
        "Selected check or change classification did not succeed",
      );
    console.log(`check passed (${mode})`);
  } else if (!base || !head)
    throw new Error(
      "Usage: check.mjs classify|docs BASE HEAD, or gate with CHECK_NEEDS",
    );
  else if (command === "classify") console.log(classify(base, head));
  else if (command === "docs") checkDocs(base, head);
  else throw new Error("Unknown command");
} catch (error) {
  console.error(error.stdout?.trim() || error.message);
  process.exitCode = 1;
}
