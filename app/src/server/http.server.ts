import { renderErrorPage } from "../lib/error-page";

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
export const HDEX_API_RESPONSE_HEADER = "X-HDEX-API-Response";

export function jsonNoStore(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set(HDEX_API_RESPONSE_HEADER, "1");
  return Response.json(value, { ...init, headers });
}

export function isApiRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function unexpectedRequestErrorResponse(request: Request, status = 500): Response {
  if (isApiRequest(request)) {
    return jsonNoStore(
      {
        ok: false,
        error: {
          code: "unexpected",
          message: "서버 연결 요청을 처리하지 못했습니다.",
        },
      },
      { status },
    );
  }
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function appendSealedCookie(
  headers: Headers,
  name: string,
  value: string,
  options: { path: string; maxAge: number },
): void {
  headers.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; Secure; SameSite=Lax`,
  );
}

export function clearSealedCookie(headers: Headers, name: string, path: string): void {
  appendSealedCookie(headers, name, "", { path, maxAge: 0 });
}

export function redirectNoStore(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...NO_STORE_HEADERS },
  });
}

export function rejectCrossSiteMutation(request: Request, publicOrigin: string): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return jsonNoStore({ error: "invalid_origin" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin) {
    return jsonNoStore({ error: "invalid_origin" }, { status: 403 });
  }
  return null;
}
