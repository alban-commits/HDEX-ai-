import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { applySecurityHeaders } from "./lib/security-headers.server";
import {
  HDEX_API_RESPONSE_HEADER,
  isApiRequest,
  unexpectedRequestErrorResponse,
} from "./server/http.server";
import { startTemporaryStorageMaintenance } from "./server/temporary-storage.server";

type ServerEntry = {
  fetch: (request: Request) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
export async function normalizeCatastrophicResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.status < 400) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (isApiRequest(request) && !contentType.includes("application/json")) {
    console.error("api_request_failed");
    return unexpectedRequestErrorResponse(request, response.status);
  }
  if (response.status < 500 || !contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  const captured = consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`);
  console.error(isApiRequest(request) ? "api_request_failed" : captured);
  return unexpectedRequestErrorResponse(request);
}

export function finalizeNodeResponse(request: Request, response: Response): Response {
  const secured = applySecurityHeaders(response);
  if (isApiRequest(request) && (secured.status < 300 || secured.status >= 400)) {
    secured.headers.set(HDEX_API_RESPONSE_HEADER, "1");
  }
  return secured;
}

export default {
  async fetch(request: Request) {
    startTemporaryStorageMaintenance();
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request);
      return finalizeNodeResponse(
        request,
        await normalizeCatastrophicResponse(request, response),
      );
    } catch (error) {
      console.error(isApiRequest(request) ? "api_request_failed" : error);
      return finalizeNodeResponse(request, unexpectedRequestErrorResponse(request));
    }
  },
};
