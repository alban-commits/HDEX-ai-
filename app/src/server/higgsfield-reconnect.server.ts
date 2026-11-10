import { clearGenerationRuntime } from "./higgsfield-generation-adapter.server";
import { clearHiggsfieldRuntime, HiggsfieldMcpError } from "./higgsfield-mcp.server";

export function isHiggsfieldAuthenticationFailure(error: unknown): boolean {
  return error instanceof HiggsfieldMcpError && error.reason === "authentication_failed";
}

export async function invalidateHiggsfieldAuthentication(input: {
  sessionFingerprint: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  // Never delete browser cookies from a background API response. A stale
  // request from the previous dashboard can finish after a fresh OAuth
  // callback and otherwise erase the newly connected account. Explicit
  // disconnect remains the only endpoint that clears OAuth cookies.
  clearHiggsfieldRuntime(input.sessionFingerprint);
  await clearGenerationRuntime(input.sessionFingerprint, input.env);
}
