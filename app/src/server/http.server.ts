export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

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
    return Response.json({ error: "invalid_origin" }, { status: 403, headers: NO_STORE_HEADERS });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin) {
    return Response.json({ error: "invalid_origin" }, { status: 403, headers: NO_STORE_HEADERS });
  }
  return null;
}
