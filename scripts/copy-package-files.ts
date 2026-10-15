// Copy the repository's LICENSE and NOTICE into a package before it is
// packed (the files npm ships with each package), as Alchemy does.
//   bun scripts/copy-package-files.ts <package-dir-name>
import { copyFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const name = process.argv[2];
if (!name) throw new Error("usage: bun scripts/copy-package-files.ts <package>");
for (const file of ["LICENSE", "NOTICE"]) {
  await copyFile(path.join(root, file), path.join(root, "packages", name, file));
}
