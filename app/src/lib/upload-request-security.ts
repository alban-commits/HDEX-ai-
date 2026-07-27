export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Reject unsafe requests before the runtime buffers and parses multipart data. */
export function rejectUnsafeUploadRequest(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin != null && origin !== new URL(request.url).origin) {
    return Response.json(
      {
        ok: false,
        error: { code: "invalid_origin", message: "Cross-site uploads are not allowed." },
      },
      { status: 403 },
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength != null && Number(contentLength) > MAX_UPLOAD_BYTES) {
    return Response.json(
      {
        ok: false,
        error: { code: "file_too_large", message: "Images must be 20 MB or smaller." },
      },
      { status: 413 },
    );
  }

  return undefined;
}
