// @effect-diagnostics nodeBuiltinImport:off - Release packaging runs before any Effect runtime exists.
// Rewrites apps/server/package.json into the publishable manifest the same way
// `apps/server/scripts/cli.ts publish` does (runtime dependencies resolved from
// the pnpm catalog, no workspace devDependencies), so `vp pm pack` can produce
// the release tarball without publishing to npm. Restore with `--restore`.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { resolveCatalogDependencies } from "../lib/resolve-catalog.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const manifestPath = NodePath.join(repoRoot, "apps/server/package.json");
const backupPath = `${manifestPath}.pack-backup`;
// `yaml` is a server dependency, not a scripts one; borrow the server's resolver.
const parseYaml = (
  NodeModule.createRequire(manifestPath)("yaml") as { parse: (text: string) => unknown }
).parse;

const args = process.argv.slice(2);
if (args[0] === "--restore") {
  if (NodeFS.existsSync(backupPath)) NodeFS.renameSync(backupPath, manifestPath);
  process.exit(0);
}
const version = args[0];
if (!version) {
  process.stderr.write("usage: prepare-pack-manifest.ts <version> | --restore\n");
  process.exit(2);
}

const original = NodeFS.readFileSync(manifestPath, "utf8");
const pkg = JSON.parse(original) as {
  name: string;
  repository?: unknown;
  bin?: unknown;
  type?: string;
  engines?: unknown;
  files?: unknown;
  dependencies?: Record<string, string>;
};
const workspace = parseYaml(
  NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
) as {
  catalog?: Record<string, string>;
  overrides?: Record<string, string>;
};
const catalog = workspace.catalog ?? {};
const publishable = {
  name: pkg.name,
  repository: pkg.repository,
  bin: pkg.bin,
  type: pkg.type,
  version,
  engines: pkg.engines,
  files: pkg.files,
  dependencies: resolveCatalogDependencies(pkg.dependencies ?? {}, catalog, "apps/server"),
  overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
};
for (const [name, spec] of Object.entries(publishable.dependencies)) {
  if (spec.startsWith("workspace:"))
    throw new Error(
      `runtime dependency ${name} is a workspace package; move it to devDependencies so it gets bundled`,
    );
}
NodeFS.writeFileSync(backupPath, original);
NodeFS.writeFileSync(manifestPath, `${JSON.stringify(publishable, null, 2)}\n`);
process.stdout.write(
  `prepared ${pkg.name}@${version} with ${Object.keys(publishable.dependencies).length} dependencies\n`,
);
