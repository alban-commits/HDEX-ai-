#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const findings = [];

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

function reportMatches(files, pattern, message) {
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        findings.push(`${relative(ROOT, file)}:${index + 1} — ${message}`);
      }
    });
  }
}

const productFiles = [
  ...sourceFiles(join(ROOT, "src", "layouts")),
  ...sourceFiles(join(ROOT, "src", "routes")),
];

reportMatches(
  productFiles,
  /\bTEMPLATE_DEMO\b|\bdemo=\{true\}/,
  "remove explicit template demo mode and provide real data",
);
reportMatches(
  productFiles,
  /PLACEHOLDER ASSETS|["']\/presets\//,
  "replace shipped demo media with product-specific generated assets",
);
reportMatches(
  productFiles,
  /(?:picsum\.photos|placehold\.co|via\.placeholder|images\.unsplash\.com)/i,
  "replace remote placeholder/stock media with owned or generated assets",
);
reportMatches(
  productFiles,
  /\bsetTimeout\s*\(|\bMath\.random\s*\(/,
  "replace simulated product behavior with the real data/generation flow",
);

const demoAssetDir = join(ROOT, "public", "presets");
if (existsSync(demoAssetDir)) {
  for (const entry of readdirSync(demoAssetDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      findings.push(
        `${relative(ROOT, join(demoAssetDir, entry.name))} — remove shipped demo media after replacing its references`,
      );
    }
  }
}

if (findings.length > 0) {
  console.error("Preset scaffold adaptation is incomplete:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error(
    "\nGenerate or add final assets, wire live data/uploads/generation, then rerun bun run check:adapted.",
  );
  process.exit(1);
}

console.log("Preset scaffold adaptation check passed.");
