import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("web app uses Terra and server-side API secret binding", async () => {
  const source = await readFile(resolve(root, "src/lib/profile.functions.ts"), "utf8");
  assert.match(source, /gpt-5\.6-terra/);
  assert.match(source, /bindings\(\)\.OPENAI_API_KEY/);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{20,}/);
});

test("Higgsfield user generation models are registered", async () => {
  const source = await readFile(resolve(root, "src/lib/fnf.browser.ts"), "utf8");
  assert.match(source, /soulV2Image/);
  assert.match(source, /gptImage2/);
});

test("folder references are bundled through the generated catalog", async () => {
  const catalog = JSON.parse(
    await readFile(resolve(root, "src/data/reference-catalog.json"), "utf8"),
  );
  assert.equal(catalog.genders.length, 2);
  assert.ok(catalog.genders.every((gender) => gender.environments.length > 0));
});
