import type { MediaListResult } from "@higgsfield/fnf/media";
import type { MediaRef } from "@higgsfield/fnf/media";

/** Stop malformed backends from turning one repeated cursor into an endless loop. */
export function getNextCursor<T extends { cursor?: string | number }>(
  lastPage: T,
  allPages: readonly T[],
): string | number | undefined {
  const cursor = lastPage.cursor;
  if (cursor === undefined) return undefined;
  return allPages.slice(0, -1).some((page) => page.cursor === cursor) ? undefined : cursor;
}

/** Search/scope filters may hide loaded rows, so only the full feed auto-pages. */
export function shouldAutoLoadAssetPages(query: string, scope: string): boolean {
  return query.trim() === "" && scope === "all";
}

/** Flatten pages: keep each ref's first position and its latest fetched value. */
export function flattenMediaPages(data: { pages: readonly MediaListResult[] }): MediaRef[] {
  const refs = new Map<string, MediaRef>();
  for (const page of data.pages) {
    for (const ref of page.items) {
      refs.set(ref.id, ref);
    }
  }
  return [...refs.values()];
}
