// Build and pack the publishable packages into release-packages/, then
// validate the tarballs (the checks Alchemy's validate-publish-packages.ts
// makes, plus what npm users would trip over). Does not publish.
//   bun run pack
import { $ } from "bun";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "release-packages");
const packages = ["bunny-sdk", "bunny"];
const EXPECTED_NAMES: string[] = ["alchemy-bunny-sdk", "alchemy-bunny"];
const required = [
  "name",
  "version",
  "description",
  "homepage",
  "license",
  "author",
  "keywords",
  "repository",
  "bugs",
  "files",
  "exports",
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await $`bun run build`.cwd(root);
for (const name of packages) {
  await $`bun pm pack --destination ${out} --ignore-scripts`.cwd(path.join(root, "packages", name)).quiet();
}

const problems: string[] = [];
const versions = new Set<string>();
for (const tarball of (await readdir(out)).filter((file) => file.endsWith(".tgz"))) {
  const file = path.join(out, tarball);
  const manifest = JSON.parse(await $`tar -xOf ${file} package/package.json`.text());
  const entries = (await $`tar -tzf ${file}`.text()).trim().split("\n");
  const label = `${manifest.name}@${manifest.version}`;
  versions.add(manifest.version);
  for (const field of required) if (manifest[field] == null) problems.push(`${label}: missing ${field}`);
  if (manifest.private) problems.push(`${label}: private`);
  if (manifest.publishConfig !== undefined) problems.push(`${label}: has publishConfig (the packages publish to the public npm registry)`);
  if (!EXPECTED_NAMES.includes(String(manifest.name))) problems.push(`${label}: unexpected package name`);
  for (const section of ["dependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(manifest[section] ?? {})) {
      if (String(range).startsWith("workspace:")) problems.push(`${label}: ${section}.${dep} is ${range}`);
    }
  }
  for (const needed of ["package/lib/index.js", "package/lib/index.d.ts", "package/src/index.ts", "package/README.md", "package/LICENSE", "package/NOTICE"]) {
    if (!entries.includes(needed)) problems.push(`${label}: ${needed} missing`);
  }
  const unexpected = entries.filter((entry) => /^package\/(test|specs|scripts|patches|\.generated-specs)\//.test(entry));
  if (unexpected.length > 0) problems.push(`${label}: ships ${unexpected.length} unexpected files (${unexpected[0]}, …)`);
  console.log(`${tarball}: ${entries.length} files`);
}
if (versions.size > 1) problems.push(`packages do not share one version: ${[...versions].join(", ")}`);
if (problems.length > 0) {
  console.error(problems.map((problem) => `  ✗ ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${packages.length} packages at ${[...versions][0]} in release-packages/ (not published)`);
