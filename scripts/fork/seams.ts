#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Regenerates fork/SEAMS.md: every upstream file the fork series touches, with
// the features (Fork-Feature trailers) and `fork:` markers behind each change.
//
//   node scripts/fork/seams.ts [--check] [--base main] [--head HEAD]
//                              [--budget 40] [--out fork/SEAMS.md] [--no-write]
//
// --check exits 1 when the seam count exceeds the budget or a seam file carries
// no `fork:` marker. Dependency-free on purpose: it runs before `vp i`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

// Paths the fork owns outright. Changes there are additions, not seams.
const forkOwnedPatterns: ReadonlyArray<RegExp> = [
  /^packages\/fork-core\//,
  /^apps\/[^/]+\/src\/fork\//,
  /^packages\/[^/]+\/src\/fork\//,
  /^\.github\/workflows\/fork-/,
  /^\.agents\/skills\/fork-[^/]*\//,
  /^\.claude\/skills\/fork-/,
  /^fork\//,
  /^scripts\/fork\//,
  // Carried upstream PR #5178 (fork feature swift-ios, see fork/FEATURES.md).
  /^apps\/swift-ios\//,
  /^docs\/user\/swiftui-mobile\.md$/,
  // The Prism settings route (fork feature prism) lives in the upstream routes directory.
  /^apps\/web\/src\/routes\/(?:settings\.)?prism\.tsx$/,
];

const markerPattern = /(?:\/\/|\/\*|#|<!--)\s*fork:/g;

// Files where a `fork:` marker is impossible or pointless: JSON manifests, the
// lockfile, tests adapted to fork literals, and markdown includes.
const markerExemptPattern =
  /(?:\.test\.[cm]?[jt]sx?$|\.gen\.[cm]?[jt]sx?$|\.json$|pnpm-lock\.yaml$|\.md$)/;

interface Options {
  readonly check: boolean;
  readonly base: string;
  readonly head: string;
  readonly budget: number;
  readonly out: string;
  readonly write: boolean;
}

interface Seam {
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
  readonly deleted_file: boolean;
  readonly features: ReadonlyArray<string>;
  readonly markers: number;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  let check = false;
  let base = "main";
  let head = "HEAD";
  let budget = 40;
  let out = "fork/SEAMS.md";
  let write = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--check":
        check = true;
        break;
      case "--base":
        base = next();
        break;
      case "--head":
        head = next();
        break;
      case "--budget":
        budget = Number.parseInt(next(), 10);
        if (!Number.isFinite(budget) || budget < 0)
          throw new Error("--budget must be a non-negative integer");
        break;
      case "--out":
        out = next();
        break;
      case "--no-write":
        write = false;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: node scripts/fork/seams.ts [--check] [--base <ref>] [--head <ref>] [--budget <n>] [--out <file>] [--no-write]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check, base, head, budget, out, write };
}

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOrEmpty(args: ReadonlyArray<string>): string {
  try {
    return git(args);
  } catch {
    return "";
  }
}

// numstat prints renames as `a/{old => new}/b` or `old => new`; keep the new name.
function renameTarget(rawPath: string): string {
  const braced = rawPath.replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2").replace(/\/\//g, "/");
  const arrow = braced.indexOf(" => ");
  return arrow === -1 ? braced : braced.slice(arrow + 4);
}

function isForkOwned(filePath: string): boolean {
  return forkOwnedPatterns.some((pattern) => pattern.test(filePath));
}

function countMarkers(content: string): number {
  return content.match(markerPattern)?.length ?? 0;
}

function featuresFor(filePath: string, base: string, head: string): ReadonlyArray<string> {
  const output = gitOrEmpty([
    "log",
    `${base}..${head}`,
    "--format=%H%n%(trailers:key=Fork-Feature,valueonly)",
    "--",
    filePath,
  ]);
  const features = new Set<string>();
  for (const line of output.split("\n")) {
    const value = line.trim();
    if (value === "" || /^[0-9a-f]{40}$/.test(value)) continue;
    features.add(value);
  }
  return [...features].sort();
}

function collectSeams(options: Options): ReadonlyArray<Seam> {
  const numstat = git(["diff", "--numstat", "-M", `${options.base}...${options.head}`]);
  const seams: Array<Seam> = [];
  for (const line of numstat.split("\n")) {
    if (line.trim() === "") continue;
    const [addedRaw, deletedRaw, ...rest] = line.split("\t");
    const filePath = renameTarget(rest.join("\t"));
    if (addedRaw === undefined || deletedRaw === undefined || filePath === "") continue;
    if (isForkOwned(filePath)) continue;
    const binary = addedRaw === "-";
    const existsAtHead = catFileExists(options.head, filePath);
    const content = binary || !existsAtHead ? "" : git(["show", `${options.head}:${filePath}`]);
    seams.push({
      path: filePath,
      added: binary ? 0 : Number.parseInt(addedRaw, 10),
      deleted: binary ? 0 : Number.parseInt(deletedRaw, 10),
      binary,
      deleted_file: !existsAtHead,
      features: featuresFor(filePath, options.base, options.head),
      markers: countMarkers(content),
    });
  }
  return seams.sort((left, right) => left.path.localeCompare(right.path));
}

function catFileExists(ref: string, filePath: string): boolean {
  try {
    NodeChildProcess.execFileSync("git", ["cat-file", "-e", `${ref}:${filePath}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function renderMarkdown(seams: ReadonlyArray<Seam>, options: Options): string {
  const baseSha = git(["rev-parse", "--short", options.base]).trim();
  const headSha = git(["rev-parse", "--short", options.head]).trim();
  const totalLines = seams.reduce((sum, seam) => sum + seam.added + seam.deleted, 0);
  const lines = [
    "# Seams",
    "",
    "Generated by `node scripts/fork/seams.ts`. Do not edit by hand.",
    "",
    "Upstream files touched by the fork series (main...HEAD).",
    `Files: ${seams.length} of ${options.budget} budget. Lines changed: ${totalLines}.`,
    "",
    "| file | lines changed | features | markers |",
    "| --- | ---: | --- | ---: |",
  ];
  for (const seam of seams) {
    const changed = seam.binary ? "binary" : `+${seam.added} / -${seam.deleted}`;
    const features = seam.features.length === 0 ? "(none)" : seam.features.join(", ");
    const markers = seam.deleted_file ? "deleted" : seam.binary ? "n/a" : String(seam.markers);
    lines.push(`| \`${seam.path}\` | ${changed} | ${features} | ${markers} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const seams = collectSeams(options);
  const markdown = renderMarkdown(seams, options);

  if (options.write) {
    const outPath = NodePath.resolve(repoRoot, options.out);
    NodeFS.mkdirSync(NodePath.dirname(outPath), { recursive: true });
    NodeFS.writeFileSync(outPath, markdown);
  }

  process.stdout.write(`${seams.length} seam file(s), budget ${options.budget}\n`);
  if (!options.check) return 0;

  const problems: Array<string> = [];
  if (seams.length > options.budget) {
    problems.push(`seam budget exceeded: ${seams.length} files > ${options.budget}`);
  }
  for (const seam of seams) {
    if (seam.deleted_file) {
      problems.push(`${seam.path}: upstream file deleted by the fork series`);
    } else if (!seam.binary && seam.markers === 0 && !markerExemptPattern.test(seam.path)) {
      problems.push(`${seam.path}: no \`fork:\` marker`);
    }
  }
  for (const problem of problems) process.stderr.write(`seams: ${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
