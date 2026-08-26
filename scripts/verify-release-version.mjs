import { readFile } from "node:fs/promises";

const packageFiles = [
  "packages/contracts/package.json",
  "packages/server/package.json",
  "packages/client-core/package.json",
];

const releaseVersion = process.env.RELEASE_VERSION?.replace(/^v/, "");

if (!releaseVersion) {
  throw new Error("RELEASE_VERSION must contain the GitHub release tag");
}

for (const packageFile of packageFiles) {
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));

  if (packageJson.version !== releaseVersion) {
    throw new Error(
      `${packageJson.name} is ${packageJson.version}, expected ${releaseVersion}`,
    );
  }
}

console.log(`All public packages match release ${releaseVersion}`);
