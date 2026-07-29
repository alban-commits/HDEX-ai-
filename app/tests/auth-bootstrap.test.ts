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
import { composeInfluencerProfile } from "../src/lib/profile.browser";
import {
  HDEX_ADAPTER_BODY_SENTINEL_KEY,
  HDEX_ADAPTER_BODY_SENTINEL_VALUE,
  HDEX_ADAPTER_MAX_JSON_BYTES,
} from "../src/lib/app-api-contract";

function appJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("X-HDEX-API-Response", "1");
  return Response.json(value, { ...init, headers });
}

async function caught(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

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
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBeNull();
    return appJson({
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
    appJson(
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

test("accepts a valid marked adapter envelope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    appJson({ ok: true, value: { id: "higgsfield-oauth", workspace_id: "personal" } });
  try {
    expect(await fnfBrowserAdapter.getUser()).toEqual({
      id: "higgsfield-oauth",
      workspace_id: "personal",
    });
  } finally {
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

test("rejects an unmarked JSON response before reading its body", async () => {
  const originalFetch = globalThis.fetch;
  const response = Response.json({
    ok: true,
    value: { private_token: "private-body" },
    [HDEX_ADAPTER_BODY_SENTINEL_KEY]: HDEX_ADAPTER_BODY_SENTINEL_VALUE,
  });
  globalThis.fetch = async () => response;
  try {
    const thrown = await caught(() => fnfBrowserAdapter.getUser());
    expect(thrown).toMatchObject({
      code: "adapter_non_app_response",
      data: {
        httpStatus: 200,
        contentTypePresent: true,
        contentType: "application/json",
        appResponseHeaderMatches: false,
        failureStage: "app_header_missing",
      },
    });
    expect(response.bodyUsed).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain("private-body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts only a bounded sentinel-marked adapter error without the response header", async () => {
  const originalFetch = globalThis.fetch;
  const valid = Response.json(
    {
      ok: false,
      error: { code: "outcome_unknown", message: "생성 결과를 확인할 수 없습니다.", status: 502 },
      [HDEX_ADAPTER_BODY_SENTINEL_KEY]: HDEX_ADAPTER_BODY_SENTINEL_VALUE,
    },
    { status: 502 },
  );
  const missingSentinel = Response.json(
    {
      ok: false,
      error: { code: "private-error", message: "private response body", status: 502 },
    },
    { status: 502 },
  );
  const oversized = new Response(
    JSON.stringify({
      ok: false,
      error: { code: "private-error", message: "x".repeat(HDEX_ADAPTER_MAX_JSON_BYTES) },
      [HDEX_ADAPTER_BODY_SENTINEL_KEY]: HDEX_ADAPTER_BODY_SENTINEL_VALUE,
    }),
    { status: 502, headers: { "content-type": "application/json" } },
  );
  let index = 0;
  globalThis.fetch = async () => [valid, missingSentinel, oversized][index++]!;
  try {
    const accepted = await caught(() => fnfBrowserAdapter.getUser());
    expect(accepted).toMatchObject({ code: "outcome_unknown", status: 502 });

    for (const response of [missingSentinel, oversized]) {
      const rejected = await caught(() => fnfBrowserAdapter.getUser());
      expect(rejected).toMatchObject({
        code: "adapter_non_app_response",
        data: {
          httpStatus: 502,
          contentType: "application/json",
          appResponseHeaderMatches: false,
          failureStage: "app_header_missing",
        },
      });
      expect(JSON.stringify(rejected)).not.toContain("private response body");
      expect(JSON.stringify(rejected)).not.toContain("private-error");
      expect(JSON.stringify(rejected)).not.toContain("x".repeat(100));
      expect(response.bodyUsed).toBe(true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("separates marked malformed JSON from an invalid marked envelope", async () => {
  const originalFetch = globalThis.fetch;
  const malformed = new Response('{"private_token":', {
    status: 500,
    headers: {
      "content-type": "application/json",
      "X-HDEX-API-Response": "1",
    },
  });
  const invalidEnvelope = appJson(
    { ok: "not-boolean", private_token: "private-envelope" },
    { status: 500 },
  );
  let index = 0;
  globalThis.fetch = async () => [malformed, invalidEnvelope][index++]!;
  try {
    const malformedError = await caught(() => fnfBrowserAdapter.getUser());
    expect(malformedError).toMatchObject({
      code: "adapter_invalid_json_response",
      data: {
        appResponseHeaderMatches: true,
        failureStage: "json_parse_failed",
      },
    });
    expect(malformedError).not.toBeInstanceOf(SyntaxError);
    expect(JSON.stringify(malformedError)).not.toContain("private_token");

    const contractError = await caught(() => fnfBrowserAdapter.getUser());
    expect(contractError).toMatchObject({
      code: "adapter_response_contract_invalid",
      data: {
        appResponseHeaderMatches: true,
        failureStage: "envelope_contract_invalid",
      },
    });
    expect(JSON.stringify(contractError)).not.toContain("private-envelope");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects marked HTML without reading or exposing its body", async () => {
  const originalFetch = globalThis.fetch;
  const response = new Response("<!doctype html><p>private-token private-cookie</p>", {
      status: 500,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "X-HDEX-API-Response": "1",
      },
  });
  globalThis.fetch = async () => response;
  try {
    const thrown = await caught(() => fnfBrowserAdapter.getUser());
    expect(thrown).toMatchObject({
      code: "adapter_invalid_json_response",
      data: { contentType: "text/html", failureStage: "content_type_invalid" },
    });
    expect(response.bodyUsed).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain("private-token");
    expect(JSON.stringify(thrown)).not.toContain("private-cookie");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("separates upload Access redirects and unmarked HTML without exposing either response", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    {
      status: 0,
      type: "opaqueredirect",
      redirected: false,
      url: "https://access.example/login?token=private-upload-query",
      headers: new Headers(),
      bodyUsed: false,
    } as Response,
    new Response("<!doctype html><p>private-upload-body</p>", {
      status: 500,
      headers: { "content-type": "text/html" },
    }),
  ];
  let index = 0;
  globalThis.fetch = async () => responses[index++]!;
  try {
    const accessError = await caught(() =>
      uploadAsset(new File(["image"], "access.png", { type: "image/png" })),
    );
    expect(accessError).toMatchObject({ code: "access_session_required" });
    expect(JSON.stringify(accessError)).not.toContain("private-upload-query");

    const htmlError = await caught(() =>
      uploadAsset(new File(["image"], "html.png", { type: "image/png" })),
    );
    expect(htmlError).toMatchObject({
      code: "adapter_non_app_response",
      data: { contentType: "text/html", appResponseHeaderMatches: false },
    });
    expect(responses[1]?.bodyUsed).toBe(false);
    expect(JSON.stringify(htmlError)).not.toContain("private-upload-body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("separates profile Access redirects and unmarked HTML without exposing FormData", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    appJson({ ok: true, ref: { id: "profile-pose-media", type: "image" } });
  try {
    await uploadAsset(new File(["image"], "pose.png", { type: "image/png" }));
    const input = {
      data: {
        gender: "female" as const,
        environment: "studio",
        scene: "standing",
        imageType: "editorial",
        poseMediaId: "profile-pose-media",
        referenceImageUrls: [],
      },
    };
    const responses = [
      {
        status: 0,
        type: "opaqueredirect",
        redirected: false,
        url: "https://access.example/login?token=private-profile-query",
        headers: new Headers(),
        bodyUsed: false,
      } as Response,
      new Response("<!doctype html><p>private-profile-body</p>", {
        status: 500,
        headers: { "content-type": "text/html" },
      }),
    ];
    let index = 0;
    globalThis.fetch = async (path, init) => {
      expect(path).toBe("/api/openai/profile");
      expect(init?.redirect).toBe("manual");
      expect(init?.body).toBeInstanceOf(FormData);
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBeNull();
      return responses[index++]!;
    };

    const accessError = await caught(() => composeInfluencerProfile(input));
    expect(accessError).toMatchObject({ code: "access_session_required" });
    expect(JSON.stringify(accessError)).not.toContain("private-profile-query");

    const htmlError = await caught(() => composeInfluencerProfile(input));
    expect(htmlError).toMatchObject({
      code: "adapter_non_app_response",
      data: { contentType: "text/html", appResponseHeaderMatches: false },
    });
    expect(responses[1]?.bodyUsed).toBe(false);
    expect(JSON.stringify(htmlError)).not.toContain("private-profile-body");
  } finally {
    releaseAllLocalUploads();
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
    return appJson({ ok: true, ref: { id: `bounded-media-${id}`, type: "image" } });
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
