import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = resolve(repositoryRoot, "site");
const htmlFiles = ["index.html", "demo.html", "integrations.html"];
const htmlPages = await Promise.all(htmlFiles.map(async file => ({
  file,
  content: await readFile(resolve(siteRoot, file), "utf8")
})));
const css = await readFile(resolve(siteRoot, "styles.css"), "utf8");
const javascript = await readFile(resolve(siteRoot, "demo.js"), "utf8");
const publicContent = `${htmlPages.map(page => page.content).join("\n")}\n${css}\n${javascript}`;

const forbiddenPrivateReferences = [
  /\bEnviro\b/i,
  /L[’']?Oréal/i,
  /\bLoreal\b/i
];

for (const reference of forbiddenPrivateReferences) {
  if (reference.test(publicContent)) {
    throw new Error(`Private integration reference found in public site: ${reference}`);
  }
}

let idCount = 0;
let localAssetCount = 0;
for (const page of htmlPages) {
  const ids = [...page.content.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  idCount += ids.length;
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate HTML id in ${page.file}: ${[...new Set(duplicateIds)].join(", ")}`);
  }

  for (const match of page.content.matchAll(/href="#([^"]+)"/g)) {
    if (!ids.includes(match[1])) throw new Error(`Missing anchor target in ${page.file}: #${match[1]}`);
  }

  const localAssets = [...page.content.matchAll(/(?:href|src)="\.\/([^"#]+)"/g)].map(match => match[1]);
  localAssetCount += localAssets.length;
  for (const asset of localAssets) await access(resolve(siteRoot, asset));

  for (const requiredMeta of ["og:title", "og:description", "og:image", "twitter:card", "twitter:image"]) {
    if (!page.content.includes(requiredMeta)) throw new Error(`Missing ${requiredMeta} metadata in ${page.file}`);
  }
}

for (const requiredFile of [...htmlFiles, "styles.css", "demo.js", "og.png", "README.md"]) {
  await access(resolve(siteRoot, requiredFile));
}

console.log(`Site checks passed: ${htmlFiles.length} pages, ${idCount} anchors and ${localAssetCount} local references verified.`);
