import { getRequest } from "@tanstack/react-start/server";
import { higgsfieldOAuthSessionFingerprint } from "@/server/higgsfield-oauth.server";
import { requireActiveOAuthSession } from "@/server/oauth-routes.server";

/** Compatibility boundary for existing server functions during the Node/OAuth transition. */
export async function requireCurrentUser(): Promise<
  { ok: true; user: { id?: string } } | { ok: false; status: number }
> {
  const active = await requireActiveOAuthSession(getRequest());
  if (!active) return { ok: false, status: 401 };
  return {
    ok: true,
    user: { id: higgsfieldOAuthSessionFingerprint(active.session) },
  };
}
