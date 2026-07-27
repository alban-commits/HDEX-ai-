import { describe, expect, test } from "bun:test";
import { applySecurityHeaders } from "../src/lib/security-headers.server";
import { MAX_UPLOAD_BYTES, rejectUnsafeUploadRequest } from "../src/lib/upload-request-security";

describe("response security headers", () => {
  test("allows only the host approval iframe origins", () => {
    const response = applySecurityHeaders(new Response("ok"));
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src 'self' https://auth.higgsfield.app https://auth.higgsfield-dev.app;",
    );
    expect(response.headers.get("content-security-policy")).not.toContain("frame-ancestors");
  });
});

describe("upload request boundary", () => {
  test("rejects a cross-site browser upload", () => {
    const response = rejectUnsafeUploadRequest(
      new Request("https://app.example/api/media/upload", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
    );
    expect(response?.status).toBe(403);
  });

  test("rejects a declared oversized body before multipart parsing", () => {
    const response = rejectUnsafeUploadRequest(
      new Request("https://app.example/api/media/upload", {
        method: "POST",
        headers: {
          origin: "https://app.example",
          "content-length": String(MAX_UPLOAD_BYTES + 1),
        },
      }),
    );
    expect(response?.status).toBe(413);
  });

  test("allows same-origin requests within the declared limit", () => {
    const response = rejectUnsafeUploadRequest(
      new Request("https://app.example/api/media/upload", {
        method: "POST",
        headers: {
          origin: "https://app.example",
          "content-length": String(MAX_UPLOAD_BYTES),
        },
      }),
    );
    expect(response).toBeUndefined();
  });
});
