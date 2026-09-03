#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Guards an upstream PR branch against fork leakage.
//
//   node scripts/fork/leak-check.ts --range <a>..<b>
//
// Fails (exit 1) when any commit in the range adds a line containing a fork
// identifier, or when a commit message still carries fork trailers. Prints
// every hit as `<sha> <file>:<line>: <needle>: <text>`. Dependency-free.
import * as NodeChildProcess from "node:child_process";

// Run git in the checkout the command was started from (a worktree of the fork
// counts), not where this script file happens to live.
const repoRoot = process.cwd();

const diffNeedles: ReadonlyArray<string> = [
  "@q1code/",
  "packages/fork-core",
  "/src/fork/",
  "T3FORK_",
  "fork:",
  "q1code",
  "Fork-Feature:",
  "Upstream:",
];

const trailerPattern = /^(Fork-[A-Za-z-]+|Upstream):/m;

interface Hit {
  readonly sha: string;
  readonly location: string;
  readonly needle: string;
  readonly text: string;
}

function parseRange(argv: ReadonlyArray<string>): string {
  let range: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--range") {
      range = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("usage: node scripts/fork/leak-check.ts --range <a>..<b>\n");
      process.exit(0);
    } else if (range === undefined && arg !== undefined && !arg.startsWith("--")) {
      range = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (range === undefined || !range.includes("..")) {
    throw new Error("--range <a>..<b> is required");
  }
  return range;
}

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function checkMessage(sha: string): ReadonlyArray<Hit> {
  const message = git(["show", "--no-patch", "--format=%B", sha]);
  const hits: Array<Hit> = [];
  for (const line of message.split("\n")) {
    if (trailerPattern.test(line)) {
      hits.push({ sha, location: "commit message", needle: "trailer", text: line.trim() });
    }
  }
  return hits;
}

function checkDiff(sha: string): ReadonlyArray<Hit> {
  const patch = git(["show", "--format=", "--unified=0", "--no-color", "--no-ext-diff", sha]);
  const hits: Array<Hit> = [];
  let file = "?";
  let lineNumber = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    const hunk = /^@@+ [^+]*\+(\d+)/.exec(line);
    if (hunk !== null) {
      lineNumber = Number.parseInt(hunk[1] ?? "0", 10);
      continue;
    }
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      const text = line.replace(/^\++/, "");
      for (const needle of diffNeedles) {
        if (text.includes(needle)) {
          hits.push({ sha, location: `${file}:${lineNumber}`, needle, text: text.trim() });
        }
      }
    }
    lineNumber += 1;
  }
  return hits;
}

function main(): number {
  const range = parseRange(process.argv.slice(2));
  const shas = git(["rev-list", "--reverse", range])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (shas.length === 0) {
    process.stdout.write(`leak-check: no commits in ${range}\n`);
    return 0;
  }
  const hits: Array<Hit> = [];
  for (const sha of shas) {
    hits.push(...checkMessage(sha), ...checkDiff(sha));
  }
  for (const hit of hits) {
    process.stderr.write(`${hit.sha.slice(0, 10)} ${hit.location}: ${hit.needle}: ${hit.text}\n`);
  }
  if (hits.length > 0) {
    process.stderr.write(
      `leak-check: ${hits.length} hit(s) across ${shas.length} commit(s) in ${range}\n`,
    );
    return 1;
  }
  process.stdout.write(`leak-check: ${shas.length} commit(s) in ${range} are clean\n`);
  return 0;
}

process.exit(main());
