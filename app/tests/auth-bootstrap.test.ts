import { expect, test } from "bun:test";
import {
  fetchCurrentUser,
  fnfBrowserAdapter,
  getReconnectSignInUrl,
  getFnfScopeKey,
  getLocalUploadFile,
  getSignInUrl,
  GUEST_SCOPE_KEY,
  releaseAllLocalUploads,
  releaseLocalUpload,
  subscribeHiggsfieldReconnect,
  uploadAsset,
} from "../src/lib/fnf.browser";

test("detects auth through the same-origin user route", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    expect(input).toBe("/api/user");
    expect(init?.credentials).toBe("include");
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 401 })
      : Response.json({ id: "user-1", workspaceId: "workspace-1" });
  };

  try {
    expect(await fetchCurrentUser()).toBeNull();
    expect(await fetchCurrentUser()).toEqual({ id: "user-1", workspaceId: "workspace-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("opens the public app under a guest scope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });

  try {
    expect(await getFnfScopeKey()).toBe(GUEST_SCOPE_KEY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends only guests through the app auth route", () => {
  expect(getSignInUrl(GUEST_SCOPE_KEY, "/presets?tab=popular")).toBe(
    "/api/higgsfield/oauth/connect?return=%2Fpresets%3Ftab%3Dpopular",
  );
  expect(getSignInUrl("user-1:workspace-1", "/presets")).toBeNull();
  expect(getSignInUrl(GUEST_SCOPE_KEY, "//evil.example")).toBe(
    "/api/higgsfield/oauth/connect?return=%2F",
  );
  expect(getReconnectSignInUrl("/presets?tab=history")).toBe(
    "/api/higgsfield/oauth/connect?return=%2Fpresets%3Ftab%3Dhistory",
  );
});

test("normalizes uploaded image refs before they reach generation input", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    expect(input).toBe("/api/media/upload");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    return Response.json({
      ok: true,
      ref: {
        id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
        type: "image",
      },
    });
  };

  try {
    const file = new File(["image"], "upload.png", { type: "image/png" });
    const asset = await uploadAsset(file);
    expect(asset).toMatchObject({
      ref: {
        id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
        type: "media_input",
      },
    });
    expect(asset.src.startsWith("blob:")).toBe(true);
    expect(getLocalUploadFile(asset.ref!.id)).toBe(file);
  } finally {
    releaseAllLocalUploads();
    globalThis.fetch = originalFetch;
  }
});

test("notifies the existing sign-in flow when an adapter response requires OAuth reconnect", async () => {
  const originalFetch = globalThis.fetch;
  let notifications = 0;
  const unsubscribe = subscribeHiggsfieldReconnect(() => {
    notifications += 1;
  });
  globalThis.fetch = async () =>
    Response.json(
      {
        ok: false,
        error: {
          code: "oauth_required",
          message: "Reconnect",
          data: { reconnectRequired: true },
        },
      },
      { status: 401 },
    );
  try {
    await expect(fnfBrowserAdapter.getUser()).rejects.toMatchObject({ code: "oauth_required" });
    expect(notifications).toBe(1);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test("distinguishes an Access redirect without following or exposing its URL", async () => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  let notifications = 0;
  const unsubscribe = subscribeHiggsfieldReconnect(() => {
    notifications += 1;
  });
  const responses = [
    {
      status: 0,
      type: "opaque",
      redirected: false,
      url: "https://access.example/login?token=private-access-query",
      headers: new Headers(),
      bodyUsed: false,
    },
    {
      status: 200,
      type: "opaqueredirect",
      redirected: false,
      url: "https://access.example/login?token=private-access-query",
      headers: new Headers(),
      bodyUsed: false,
    },
  ] as Response[];
  let responseIndex = 0;
  globalThis.fetch = async (_input, init) => {
    requestInit = init;
    return responses[responseIndex++]!;
  };
  try {
    for (const response of responses) {
      let thrown: unknown;
      try {
        await fnfBrowserAdapter.getUser();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "access_session_required" });
      expect(JSON.stringify(thrown)).not.toContain("private-access-query");
      expect(response.bodyUsed).toBe(false);
    }
    expect(requestInit?.redirect).toBe("manual");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/json");
    expect(notifications).toBe(0);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test("normalizes an app non-JSON response without reading or exposing its HTML", async () => {
  const originalFetch = globalThis.fetch;
  const html = "<!doctype html><p>private-token private-cookie</p>";
  const response = new Response(html, {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  globalThis.fetch = async () => response;
  try {
    let thrown: unknown;
    try {
      await fnfBrowserAdapter.getUser();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "adapter_non_json_response" });
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect(response.bodyUsed).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain("private-token");
    expect(JSON.stringify(thrown)).not.toContain("private-cookie");
    expect(JSON.stringify(thrown)).not.toContain("<!doctype html>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes malformed JSON without exposing the parser or response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"private_token":', {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  try {
    let thrown: unknown;
    try {
      await fnfBrowserAdapter.getUser();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "adapter_invalid_json_response" });
    expect(thrown).not.toBeInstanceOf(SyntaxError);
    expect(JSON.stringify(thrown)).not.toContain("private_token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounds and explicitly releases local upload object URLs", async () => {
  const originalFetch = globalThis.fetch;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let id = 0;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  globalThis.fetch = async () => {
    id += 1;
    return Response.json({ ok: true, ref: { id: `bounded-media-${id}`, type: "image" } });
  };
  try {
    for (let index = 0; index < 9; index += 1) {
      await uploadAsset(new File([`image-${index}`], `upload-${index}.png`, { type: "image/png" }));
    }
    expect(getLocalUploadFile("bounded-media-1")).toBeUndefined();
    expect(revoked).toHaveLength(1);
    releaseLocalUpload("bounded-media-9");
    expect(getLocalUploadFile("bounded-media-9")).toBeUndefined();
    expect(revoked).toHaveLength(2);
  } finally {
    releaseAllLocalUploads();
    URL.revokeObjectURL = originalRevoke;
    globalThis.fetch = originalFetch;
  }
});
