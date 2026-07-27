import { describe, expect, test } from "bun:test";
import type { MediaListResult, MediaRef } from "@higgsfield/fnf/media";
import {
  flattenMediaPages,
  getNextCursor,
  shouldAutoLoadAssetPages,
} from "../src/lib/cursor-pages";

function page(cursor?: string | number, items: MediaRef[] = []): MediaListResult {
  return { items, ...(cursor !== undefined ? { cursor } : {}) };
}

describe("cursor pages", () => {
  test("continues with a new cursor and stops a repeated cursor", () => {
    expect(getNextCursor(page("next"), [page("next")])).toBe("next");
    expect(getNextCursor(page(2), [page(1), page(2)])).toBe(2);
    expect(getNextCursor(page("same"), [page("same"), page("same")])).toBeUndefined();
  });

  test("flattens media pages without duplicate refs", () => {
    const first = { id: "one", type: "media_input" } as MediaRef;
    const duplicate = { ...first, type: "newer_type" } as MediaRef;
    const second = { id: "two", type: "media_input" } as MediaRef;

    expect(
      flattenMediaPages({ pages: [page("next", [first]), page(undefined, [duplicate, second])] }),
    ).toEqual([duplicate, second]);
  });

  test("auto-pages only the unfiltered all-assets view", () => {
    expect(shouldAutoLoadAssetPages("", "all")).toBe(true);
    expect(shouldAutoLoadAssetPages(" product ", "all")).toBe(false);
    expect(shouldAutoLoadAssetPages("", "personal")).toBe(false);
  });
});
