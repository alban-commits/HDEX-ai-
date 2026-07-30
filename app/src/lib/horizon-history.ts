import type { Generation, ListResult } from "@higgsfield/fnf/client";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { applyGenerations, fnfKeys, prependGenerations } from "@higgsfield/fnf-react";

const HORIZON_HISTORY_QUERY = { type: "image" as const, size: 40 };

/**
 * Seeds unseen jobs and folds newer snapshots through the same scoped fnf cache door.
 * This is intentionally browser-session local; persistence remains the server listJobs store.
 */
export async function syncHorizonHistory(
  queryClient: QueryClient,
  generations: readonly Generation[],
  scopeKey: string,
): Promise<void> {
  if (!generations.length) return;
  const scopedKey = fnfKeys.jobs(HORIZON_HISTORY_QUERY, { scopeKey });
  const unique = [...new Map(generations.map((generation) => [generation.id, generation])).values()];
  const state = queryClient.getQueryState(scopedKey);
  const needsServerReconciliation = state?.data === undefined;
  if (state?.fetchStatus === "fetching" && needsServerReconciliation) {
    await queryClient.cancelQueries({ queryKey: scopedKey, exact: true }, { silent: true });
  }
  queryClient.setQueryData<InfiniteData<ListResult>>(scopedKey, (previous) => previous ?? {
    pages: [{ items: unique }],
    pageParams: [undefined],
  });
  prependGenerations(queryClient, HORIZON_HISTORY_QUERY, unique, { scopeKey });
  applyGenerations(queryClient, unique, { scopeKey });
  if (needsServerReconciliation && state) {
    try {
      await queryClient.invalidateQueries({ queryKey: scopedKey, exact: true, refetchType: "all" });
    } catch {}
    prependGenerations(queryClient, HORIZON_HISTORY_QUERY, unique, { scopeKey });
    applyGenerations(queryClient, unique, { scopeKey });
  }
}

export { HORIZON_HISTORY_QUERY };
