import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const source = resolve(process.argv[2] || "");
const appRoot = resolve(import.meta.dirname, "..");
const publicTarget = join(appRoot, "public", "references");
const catalogTarget = join(appRoot, "src", "data", "reference-catalog.json");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

if (!process.argv[2]) throw new Error("Reference source path is required.");
await rm(publicTarget, { recursive: true, force: true });
await mkdir(publicTarget, { recursive: true });

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

async function findLeaves(path) {
  const leaves = [];
  for (const folder of await directories(path)) {
    const folderPath = join(path, folder.name);
    const entries = await readdir(folderPath, { withFileTypes: true });
    const images = entries
      .filter((entry) => entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"))
      .map((entry) => join(folderPath, entry.name));
    if (images.length) leaves.push({ path: folderPath, images });
    leaves.push(...(await findLeaves(folderPath)));
  }
  return leaves;
}

const clean = (value) => value.replace(/^\d+[_\s-]*/, "").replaceAll("_", " ").trim();
const genders = [];
const copiedImages = new Set();
for (const genderFolder of await directories(source)) {
  const genderPath = join(source, genderFolder.name);
  const environments = [];
  for (const environmentFolder of await directories(genderPath)) {
    const environmentPath = join(genderPath, environmentFolder.name);
    const scenes = [];
    for (const leaf of await findLeaves(environmentPath)) {
      const parts = relative(environmentPath, leaf.path).split(sep);
      for (const image of leaf.images) copiedImages.add(image);
      scenes.push({
        id: Buffer.from(relative(source, leaf.path)).toString("base64url"),
        label: parts.map(clean).join(" · "),
        images: leaf.images.slice(0, 6).map((image) => {
          const webPath = relative(source, image).split(sep).map(encodeURIComponent).join("/");
          return `/references/${webPath}`;
        }),
      });
    }
    if (scenes.length) {
      environments.push({
        id: environmentFolder.name,
        label: clean(environmentFolder.name),
        scenes,
      });
    }
  }
  if (environments.length) {
    genders.push({
      id: genderFolder.name.includes("남자") ? "male" : "female",
      label: clean(genderFolder.name),
      environments,
    });
  }
}

for (const image of copiedImages) {
  const destination = join(publicTarget, relative(source, image));
  await mkdir(resolve(destination, ".."), { recursive: true });
  await copyFile(image, destination);
}

await writeFile(catalogTarget, `${JSON.stringify({ genders }, null, 2)}\n`, "utf8");
console.log(`Imported ${genders.length} genders into ${catalogTarget}`);
