import { clearGenerationRuntime } from "./higgsfield-generation-adapter.server";
import { clearHiggsfieldRuntime, HiggsfieldMcpError } from "./higgsfield-mcp.server";
import { clearAllOAuthCookies } from "./oauth-routes.server";

export function isHiggsfieldAuthenticationFailure(error: unknown): boolean {
  return error instanceof HiggsfieldMcpError && error.reason === "authentication_failed";
}

export async function invalidateHiggsfieldAuthentication(input: {
  headers: Headers;
  sessionFingerprint: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  clearAllOAuthCookies(input.headers);
  clearHiggsfieldRuntime(input.sessionFingerprint);
  await clearGenerationRuntime(input.sessionFingerprint, input.env);
}
