#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Classifies a rebase by `git range-diff` so a sync can be promoted without a
// human when nothing in the series changed.
//
//   node scripts/fork/range-diff-classify.ts <old-base> <old-tip> <new-base> <new-tip>
//
// Prints JSON { unchanged, contextOnly, contentChanged, dropped, added } with
// commit subjects. Exit 0 when contentChanged, dropped and added are all empty
// (the deterministic gate), 2 otherwise, 1 on usage or git errors. A patch
// whose only differences are hunk headers or context lines is contextOnly;
// anything unrecognised counts as contentChanged.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

interface Entry {
  readonly oldSha: string | undefined;
  readonly newSha: string | undefined;
  readonly subject: string;
  readonly reasons: ReadonlyArray<string>;
}

interface Classification {
  readonly unchanged: ReadonlyArray<Entry>;
  readonly contextOnly: ReadonlyArray<Entry>;
  readonly contentChanged: ReadonlyArray<Entry>;
  readonly dropped: ReadonlyArray<Entry>;
  readonly added: ReadonlyArray<Entry>;
}

const headerPattern =
  /^\s*(?:\d+|-):\s+([0-9a-f]+|-+)\s+([=!<>])\s+(?:\d+|-):\s+([0-9a-f]+|-+)\s+(.*)$/;

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function shaOrUndefined(raw: string): string | undefined {
  return /^-+$/.test(raw) ? undefined : raw;
}

// Inner lines of a `!` entry are the diff between the two patches, indented by
// four spaces. A leading `-`/`+` after the indent marks a line that differs.
function classifyInner(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  const reasons = new Set<string>();
  let section: "meta" | "message" | "file" = "file";
  for (const line of lines) {
    const inner = line.slice(4);
    if (inner.startsWith("@@ ")) {
      const title = inner.slice(3).trim();
      section = title === "Metadata" ? "meta" : title === "Commit message" ? "message" : "file";
      continue;
    }
    const marker = inner[0];
    if (marker !== "-" && marker !== "+") continue;
    const rest = inner.slice(1);
    if (section === "meta") {
      reasons.add("metadata differs");
    } else if (section === "message") {
      reasons.add("commit message differs");
    } else if (rest.startsWith("@@")) {
      // hunk header offsets only
    } else if (rest.startsWith(" ")) {
      // context line only
    } else if (rest.startsWith("+") || rest.startsWith("-")) {
      reasons.add("patch content differs");
    } else {
      reasons.add(`unrecognised range-diff line: ${inner.trim()}`);
    }
  }
  return [...reasons];
}

function parse(output: string): Classification {
  const unchanged: Array<Entry> = [];
  const contextOnly: Array<Entry> = [];
  const contentChanged: Array<Entry> = [];
  const dropped: Array<Entry> = [];
  const added: Array<Entry> = [];

  const lines = output.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const header = headerPattern.exec(line);
    if (header === null) {
      index += 1;
      continue;
    }
    const [, oldRaw = "", marker = "", newRaw = "", subject = ""] = header;
    const inner: Array<string> = [];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").startsWith("    ")) {
      inner.push(lines[index] ?? "");
      index += 1;
    }
    const base = {
      oldSha: shaOrUndefined(oldRaw),
      newSha: shaOrUndefined(newRaw),
      subject: subject.trim(),
    };
    switch (marker) {
      case "=":
        unchanged.push({ ...base, reasons: [] });
        break;
      case "<":
        dropped.push({ ...base, reasons: ["missing from the new range"] });
        break;
      case ">":
        added.push({ ...base, reasons: ["not in the old range"] });
        break;
      case "!": {
        const reasons = classifyInner(inner);
        if (reasons.length === 0)
          contextOnly.push({ ...base, reasons: ["hunk offsets or context only"] });
        else contentChanged.push({ ...base, reasons });
        break;
      }
      default:
        contentChanged.push({ ...base, reasons: [`unknown range-diff marker ${marker}`] });
    }
  }
  return { unchanged, contextOnly, contentChanged, dropped, added };
}

function listCommits(base: string, tip: string): ReadonlyArray<Entry> {
  return git(["log", "--reverse", "--format=%h%x09%s", `${base}..${tip}`])
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\t");
      return { oldSha: sha, newSha: sha, subject, reasons: [] };
    });
}

// `git range-diff` rejects an empty range, so a series that vanished (or was
// created) entirely is classified directly from the commit lists.
function classify(
  oldBase: string,
  oldTip: string,
  newBase: string,
  newTip: string,
): Classification {
  const oldCommits = listCommits(oldBase, oldTip);
  const newCommits = listCommits(newBase, newTip);
  if (oldCommits.length === 0 || newCommits.length === 0) {
    return {
      unchanged: [],
      contextOnly: [],
      contentChanged: [],
      dropped: oldCommits.map((entry) => ({
        ...entry,
        newSha: undefined,
        reasons: ["missing from the new range"],
      })),
      added: newCommits.map((entry) => ({
        ...entry,
        oldSha: undefined,
        reasons: ["not in the old range"],
      })),
    };
  }
  return parse(git(["range-diff", "--no-color", `${oldBase}..${oldTip}`, `${newBase}..${newTip}`]));
}

function main(): number {
  const [oldBase, oldTip, newBase, newTip] = process.argv.slice(2);
  if (
    oldBase === undefined ||
    oldTip === undefined ||
    newBase === undefined ||
    newTip === undefined
  ) {
    process.stderr.write(
      "usage: node scripts/fork/range-diff-classify.ts <old-base> <old-tip> <new-base> <new-tip>\n",
    );
    return 1;
  }
  const result = classify(oldBase, oldTip, newBase, newTip);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const gatePasses =
    result.contentChanged.length === 0 && result.dropped.length === 0 && result.added.length === 0;
  return gatePasses ? 0 : 2;
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(
    `range-diff-classify: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
