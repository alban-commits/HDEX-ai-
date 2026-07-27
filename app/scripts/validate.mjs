import { access, readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "src/layouts/preset.tsx",
  "src/lib/profile.functions.ts",
  "src/data/base-profile.ts",
  "src/data/reference-catalog.json",
  "src/routes/api/user.ts",
  "app.manifest.json",
];

for (const file of required) await access(join(root, file));

async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(child)));
    else result.push(child);
  }
  return result;
}

const referenceFiles = await files(join(root, "public", "references"));
const referenceImages = referenceFiles.filter((file) =>
  [".jpg", ".jpeg", ".png", ".webp"].includes(extname(file).toLowerCase()),
);
if (!referenceImages.length) throw new Error("No bundled reference images found.");

const sources = await Promise.all(
  (await files(join(root, "src")))
    .filter((file) => [".ts", ".tsx"].includes(extname(file)))
    .map((file) => readFile(file, "utf8")),
);
if (sources.some((source) => /sk-[A-Za-z0-9_-]{20,}/.test(source))) {
  throw new Error("A value resembling an OpenAI API key is committed in source.");
}

console.log(`Validation passed with ${referenceImages.length} reference images.`);
