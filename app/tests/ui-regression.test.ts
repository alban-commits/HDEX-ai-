import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

describe("existing product UI regression boundary", () => {
  test("keeps the preset layout, copy, controls, tabs, and prompts byte-identical", async () => {
    const source = normalizeLineEndings(
      await readFile(new URL("../src/layouts/preset.tsx", import.meta.url), "utf8"),
    );
    const withoutAllowedConnectionHooks = source
      .replace(
        /import \{\n {2}GUEST_SCOPE_KEY,[\s\S]*? {2}uploadAsset,\n\} from "@\/lib\/fnf\.browser";/,
        'import { GUEST_SCOPE_KEY, getSignInUrl, PRESET_JOBS, uploadAsset } from "@/lib/fnf.browser";',
      )
      .replace(/\n {2}useEffect\([\s\S]*?\n\n {2}const history/, "\n  const history")
      .replace(
        /\n {2}const selectPose = useCallback[\s\S]*?\n\n {2}const handleUpload/,
        "\n  const handleUpload",
      )
      .replaceAll("selectPose(selected)", "setPose(selected)")
      .replace("}, [selectPose]);", "}, []);")
      .replace("onSelect={selectPose}", "onSelect={setPose}")
      .replace(/\n {18}if \(pose\.ref\?\.id\) \{[\s\S]*?\n {18}\}/, "")
      .replace("@/lib/profile.browser", "@/lib/profile.functions")
      .replace('poseMediaId: pose.ref?.id ?? ""', "poseImageUrl: pose.src");
    expect(sha256(withoutAllowedConnectionHooks)).toBe(
      "fc1b405dc6d1a9edb0dbb9bb0963af619a06a0fd718a3045a9751d6c696ea1e8",
    );
  });

  test("keeps the existing SignInModal DOM, copy, and styling unchanged", async () => {
    const source = normalizeLineEndings(
      await readFile(
        new URL("../src/components/sign-in-modal/sign-in-modal.tsx", import.meta.url),
        "utf8",
      ),
    );
    expect(sha256(source)).toBe("57af5005afaae0f46b9793034f7d7263c2a14b3ec882df8464eb5217ced2fd3a");
  });
});
