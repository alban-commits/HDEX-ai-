import { getRemoteResultUrl } from "./higgsfield-generation-adapter.server";
import { higgsfieldOAuthSessionFingerprint } from "./higgsfield-oauth.server";
import { appendOAuthSessionCookies, requireActiveOAuthSession } from "./oauth-routes.server";
import { NO_STORE_HEADERS } from "./http.server";
import { downloadResultThroughTemporaryFile } from "./result-download.server";

export async function handleHiggsfieldResult(request: Request, jobId: string): Promise<Response> {
  const active = await requireActiveOAuthSession(request);
  if (!active) {
    return Response.json({ error: "oauth_required" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  const remoteUrl = await getRemoteResultUrl(higgsfieldOAuthSessionFingerprint(active.session), jobId);
  if (!remoteUrl) {
    return Response.json({ error: "result_not_ready" }, { status: 404, headers: NO_STORE_HEADERS });
  }
  try {
    const response = await downloadResultThroughTemporaryFile({ remoteUrl, jobId });
    if (active.rotatedCookies) appendOAuthSessionCookies(response.headers, active.rotatedCookies);
    return response;
  } catch {
    return Response.json(
      { error: "result_download_failed" },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
