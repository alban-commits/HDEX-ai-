import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callHiggsfieldMcpTool,
  clearHiggsfieldRuntime,
  getHiggsfieldCapabilitySummary,
  HiggsfieldMcpError,
  HIGGSFIELD_MCP_MAX_RESPONSE_BYTES,
  HIGGSFIELD_MCP_TIMEOUT_MS,
  inspectHiggsfieldCapabilities,
  inspectHiggsfieldProvider,
  type HiggsfieldCapabilityRecord,
} from "../src/server/higgsfield-mcp.server";
import {
  clearGenerationRuntime,
  createHiggsfieldGeneration,
  getHiggsfieldGeneration,
  getRemoteResultUrl,
  listHiggsfieldGenerations,
} from "../src/server/higgsfield-generation-adapter.server";
import { uploadHiggsfieldImage } from "../src/server/higgsfield-media.server";
import type { HiggsfieldOAuthSession } from "../src/server/higgsfield-oauth.server";
import {
  hasGenerationMedia,
  GENERATION_STATE_SCHEMA_VERSION,
  generationRequestHash,
  registerGenerationMedia,
} from "../src/server/generation-attempt-store.server";
import {
  invalidateHiggsfieldAuthentication,
  isHiggsfieldAuthenticationFailure,
} from "../src/server/higgsfield-reconnect.server";

const NOW = Date.UTC(2099, 0, 1, 5, 0, 0);
const GENERATION_TEMP_DIR = await mkdtemp(join(tmpdir(), "hdex-mcp-boundaries-"));
const GENERATION_ENV = {
  HDEX_GENERATION_ENABLED: "true",
  HDEX_TEMP_DIR: GENERATION_TEMP_DIR,
  HDEX_TEMP_TTL_SECONDS: "3600",
} as NodeJS.ProcessEnv;

afterAll(async () => {
  await rm(GENERATION_TEMP_DIR, { recursive: true, force: true });
});

function generationStateFile(fingerprint: string, root = GENERATION_TEMP_DIR): string {
  return join(root, "hdex-influencer-frame", "jobs", `${fingerprint}.json`);
}

const tools = [
  {
    name: "models_explore",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["search", "get", "list"] } },
    },
  },
  {
    name: "media_upload",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { filename: { type: "string" }, content_type: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "media_confirm",
    inputSchema: {
      type: "object",
      properties: {
        media_ids: { type: "array", items: { type: "string" } },
        type: { type: "string" },
      },
    },
  },
  {
    name: "generate_image",
    inputSchema: {
      type: "object",
      properties: {
        params: {
          anyOf: [
            {
              type: "object",
              properties: {
                aspect_ratio: { type: "string" },
                medias: {
                  type: "array",
                  minItems: 0,
                  maxItems: 4,
                  items: {
                    type: "object",
                    required: ["role", "value"],
                    properties: { role: { type: "string" }, value: { type: "string" } },
                  },
                },
              },
            },
            {
              type: "object",
              properties: {
                aspect_ratio: { type: "string" },
                medias: {
                  type: "array",
                  minItems: 0,
                  maxItems: 4,
                  items: {
                    type: "object",
                    required: ["role", "value"],
                    properties: { role: { type: "string" }, value: { type: "string" } },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  {
    name: "job_status",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } } },
  },
];

function detail(name: "Soul 2" | "GPT Image 2") {
  const soul = name === "Soul 2";
  const aspects = ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"];
  return {
    id: soul ? "runtime/soul-model" : "runtime/gpt-image-model",
    name: soul ? "Higgsfield Soul V2" : name,
    provider_name: soul ? "Higgsfield" : "OpenAI",
    output_type: "image",
    parameters: soul
      ? [
          { name: "aspect_ratio", options: aspects },
          { name: "quality", options: ["1.5k", "2k"] },
        ]
      : [
          { name: "aspect_ratio", options: aspects },
          { name: "resolution", options: ["2K"] },
          { name: "quality", options: ["high"] },
        ],
    aspect_ratios: aspects,
    medias: [{ roles: ["reference"], max: soul ? 1 : 4 }],
  };
}

function soulDetail(id: string) {
  return { ...structuredClone(detail("Soul 2")), id };
}

function canonicalDetail(name: "Soul 2" | "GPT Image 2"): Record<string, unknown> {
  return {
    ...structuredClone(detail(name)),
    id: name === "Soul 2" ? "soul_v2" : "gpt_image_2",
  };
}

async function discoveredRecord(): Promise<{
  record: HiggsfieldCapabilityRecord;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const record = await inspectHiggsfieldProvider({
    now: NOW,
    listTools: async () => ({ tools }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (args.action === "search") {
        const model = detail(String(args.query).includes("Soul") ? "Soul 2" : "GPT Image 2");
        return {
          structuredContent: {
            models: [
              {
                id: model.id,
                name: model.name,
                provider_name: model.provider_name,
                output_type: model.output_type,
              },
            ],
          },
        };
      }
      return {
        structuredContent:
          args.model_id === "soul_v2"
            ? canonicalDetail("Soul 2")
            : canonicalDetail("GPT Image 2"),
      };
    },
  });
  return { record, calls };
}

const session: HiggsfieldOAuthSession = {
  schemaVersion: "hdex.higgsfield-oauth-session.v1",
  accessToken: "secret-access-token",
  refreshToken: "secret-refresh-token",
  clientId: "secret-client-id",
  tokenEndpoint: "https://auth.higgsfield.ai/token",
  resource: "https://mcp.higgsfield.ai/mcp",
  accessExpiresAt: NOW + 3_600_000,
  sessionExpiresAt: NOW + 86_400_000,
};

async function seed(fingerprint: string): Promise<HiggsfieldCapabilityRecord> {
  const { record } = await discoveredRecord();
  return inspectHiggsfieldCapabilities({
    sessionFingerprint: fingerprint,
    mcpUrl: session.resource,
    accessToken: session.accessToken,
    now: NOW,
    runner: async () => record,
  });
}

async function capturedError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

describe("Higgsfield MCP discovery boundary", () => {
  test("discovers Soul 2 and GPT Image 2 from models_explore without a paid create", async () => {
    const { record, calls } = await discoveredRecord();
    expect(
      record.models.map((model) => ({ name: model.displayName, ready: model.available })),
    ).toEqual([
      { name: "Soul 2", ready: true },
      { name: "GPT Image 2", ready: true },
    ]);
    expect(record.models.map((model) => model.modelId)).toEqual([
      "soul_v2",
      "gpt_image_2",
    ]);
    expect(record.models[0]).toMatchObject({
      mediaRole: "reference",
      maximumImages: 1,
      aspectRatios: ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"],
    });
    expect(record.models[0]?.parameterOptions?.quality).toEqual(["1.5k", "2k"]);
    expect(record.models[1]?.parameterOptions?.resolution).toEqual(["2K"]);
    expect(record.models[1]?.parameterOptions?.quality).toEqual(["high"]);
    const generateSchema = record.tools.find((tool) => tool.name === "generate_image")?.inputSchema;
    expect(generateSchema?.properties?.params?.anyOf).toHaveLength(2);
    expect(calls.map((call) => call.name)).toEqual(["models_explore", "models_explore"]);
    expect(calls.some((call) => call.name === ("generate_image" as string))).toBe(false);
    expect(calls.filter((call) => call.args.action === "get")).toHaveLength(2);
  });

  test("accepts canonical GPT Image 2 when detail metadata and media max are omitted", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const gpt = canonicalDetail("GPT Image 2");
    delete gpt.provider_name;
    delete gpt.output_type;
    gpt.parameters = [
      { name: "aspect_ratio", options: ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"] },
      { name: "resolution", options: ["1k", "2k", "4k"] },
      { name: "quality", options: ["low", "medium", "high"] },
    ];
    gpt.medias = [{ roles: ["provider_image_reference"] }];
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (args.action === "search") {
          const soul = String(args.query).includes("Soul");
          return {
            structuredContent: {
              models: [
                soul
                  ? { id: "soul_v2", name: "Higgsfield Soul V2" }
                  : { id: "gpt_image_2", name: "GPT Image 2" },
              ],
            },
          };
        }
        return {
          structuredContent:
            args.model_id === "soul_v2" ? canonicalDetail("Soul 2") : gpt,
        };
      },
    });
    expect(record.models[0]).toMatchObject({ available: true });
    expect(record.models[1]).toMatchObject({
      available: true,
      modelId: "gpt_image_2",
      mediaRole: "provider_image_reference",
      maximumImages: 4,
      resolutionValue: "2k",
      qualityValue: "high",
    });
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["models_explore"]));
  });

  test("accepts canonical Soul V2 with unique 2k and single-image execution contract", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const soul = canonicalDetail("Soul 2");
    soul.medias = [{ roles: ["provider_image_reference"], max: 1 }];
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (args.action === "search") {
          const isSoul = String(args.query).includes("Soul");
          return {
            structuredContent: {
              models: [
                isSoul
                  ? { id: "soul_v2", name: "Higgsfield Soul V2" }
                  : { id: "gpt_image_2", name: "GPT Image 2" },
              ],
            },
          };
        }
        return {
          structuredContent: args.model_id === "soul_v2" ? soul : canonicalDetail("GPT Image 2"),
        };
      },
    });
    expect(record.models[0]).toMatchObject({
      available: true,
      modelId: "soul_v2",
      mediaRole: "provider_image_reference",
      maximumImages: 1,
      resolutionParameter: "quality",
      resolutionValue: "2k",
    });
    expect(record.models[1]).toMatchObject({ available: true });
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["models_explore"]));
  });

  test("rejects explicit search and detail provider or output conflicts", async () => {
    for (const conflicting of [
      { provider_name: "Different Provider", output_type: "image" },
      { provider_name: "OpenAI", output_type: "video" },
    ]) {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const record = await inspectHiggsfieldProvider({
        now: NOW,
        listTools: async () => ({ tools }),
        callTool: async (name, args) => {
          calls.push({ name, args });
          if (args.action === "search") {
            const soul = String(args.query).includes("Soul");
            return {
              structuredContent: {
                models: [
                  soul
                    ? { id: "soul_v2", name: "Higgsfield Soul V2" }
                    : {
                        id: "gpt_image_2",
                        name: "GPT Image 2",
                        provider_name: "OpenAI",
                        output_type: "image",
                      },
                ],
              },
            };
          }
          return {
            structuredContent:
              args.model_id === "soul_v2"
                ? canonicalDetail("Soul 2")
                : { ...canonicalDetail("GPT Image 2"), ...conflicting },
          };
        },
      });
      expect(record.models[0]).toMatchObject({ available: true });
      expect(record.models[1]).toMatchObject({ available: false, reason: "profile_invalid" });
      expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["models_explore"]));
    }
  });

  test("rejects an explicit provider media max below the app limit", async () => {
    const gpt = canonicalDetail("GPT Image 2");
    gpt.medias = [{ roles: ["provider_image_reference"], max: 3 }];
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (_name, args) => {
        if (args.action === "search") {
          const soul = String(args.query).includes("Soul");
          return {
            structuredContent: {
              models: [
                soul
                  ? { id: "soul_v2", name: "Higgsfield Soul V2" }
                  : { id: "gpt_image_2", name: "GPT Image 2" },
              ],
            },
          };
        }
        return {
          structuredContent:
            args.model_id === "soul_v2" ? canonicalDetail("Soul 2") : gpt,
        };
      },
    });
    expect(record.models[0]).toMatchObject({ available: true });
    expect(record.models[1]).toMatchObject({ available: false, reason: "profile_invalid" });
  });

  test("accepts executable generate_image params oneOf branches without repeated common fields", async () => {
    const oneOfTools = structuredClone(tools);
    const params = oneOfTools.find((tool) => tool.name === "generate_image")!.inputSchema.properties
      .params;
    params.oneOf = params.anyOf;
    delete params.anyOf;
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools: oneOfTools }),
      callTool: async (_name, args) => {
        const model = canonicalDetail(
          args.model_id === "soul_v2" ? "Soul 2" : "GPT Image 2",
        );
        return args.action === "search"
          ? { structuredContent: { models: [model] } }
          : { structuredContent: model };
      },
    });
    expect(record.models.every((model) => model.available)).toBe(true);
  });

  test("browser summary exposes readiness but not model IDs or input contracts", async () => {
    const fingerprint = "summary-session";
    await seed(fingerprint);
    const serialized = JSON.stringify(getHiggsfieldCapabilitySummary(fingerprint, NOW));
    expect(serialized).toContain("Soul 2");
    expect(serialized).toContain("GPT Image 2");
    expect(serialized).not.toContain("runtime/soul-model");
    expect(serialized).not.toContain("inputContractHash");
    clearHiggsfieldRuntime(fingerprint);
  });

  test("does not repopulate capability cache from a flight invalidated by reconnect", async () => {
    const fingerprint = "invalidated-flight-session";
    const { record } = await discoveredRecord();
    let resolveFlight!: (value: HiggsfieldCapabilityRecord) => void;
    const runner = new Promise<HiggsfieldCapabilityRecord>((resolve) => {
      resolveFlight = resolve;
    });
    const inspection = inspectHiggsfieldCapabilities({
      sessionFingerprint: fingerprint,
      mcpUrl: session.resource,
      accessToken: session.accessToken,
      now: NOW,
      runner: async () => runner,
    });
    clearHiggsfieldRuntime(fingerprint);
    resolveFlight(record);
    await inspection;
    expect(getHiggsfieldCapabilitySummary(fingerprint, NOW)).toEqual({
      status: "not_checked",
      models: [],
    });
  });

  test("does not mark capability ready when tool pagination is truncated", async () => {
    let generateCalls = 0;
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools, nextCursor: "still-more" }),
      callTool: async (_name, args) => {
        if (args.action === "generate_image") generateCalls += 1;
        if (args.action === "search") {
          const model = detail(String(args.query).includes("Soul") ? "Soul 2" : "GPT Image 2");
          return { structuredContent: { models: [{ id: model.id, name: model.name }] } };
        }
        return {
          structuredContent: detail(
            args.model_id === "runtime/soul-model" ? "Soul 2" : "GPT Image 2",
          ),
        };
      },
    });
    expect(record.pageCount).toBe(2);
    expect(record.models.every((model) => !model.available)).toBe(true);
    expect(generateCalls).toBe(0);
  });

  test("keeps bounded search and list only as diagnostics after canonical lookup fails", async () => {
    let listCalls = 0;
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (_name, args) => {
        if (args.action === "search") return { structuredContent: { models: [] } };
        if (args.action === "list") {
          listCalls += 1;
          return {
            structuredContent: {
              models: [detail("Soul 2"), detail("GPT Image 2")].map(({ id, name }) => ({
                id,
                name,
              })),
            },
          };
        }
        return {
          structuredContent: detail(
            args.model_id === "runtime/soul-model" ? "Soul 2" : "GPT Image 2",
          ),
        };
      },
    });
    expect(
      record.models.every((model) => !model.available && model.reason === "profile_invalid"),
    ).toBe(true);
    expect(listCalls).toBe(1);
  });

  test("uses next_page_token and after for a bounded shared model catalog scan", async () => {
    const listArgs: Record<string, unknown>[] = [];
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (_name, args) => {
        if (args.action === "search") return { structuredContent: { models: [] } };
        if (args.action === "list") {
          listArgs.push(args);
          if (!args.after) {
            return { structuredContent: { models: [], next_page_token: "model-page-2" } };
          }
          if (args.after === "model-page-2") {
            return { structuredContent: { models: [], next_page_token: "model-page-3" } };
          }
          return {
            structuredContent: {
              models: [detail("Soul 2"), detail("GPT Image 2")].map(
                ({ id, name, provider_name, output_type }) => ({
                  id,
                  name,
                  provider_name,
                  output_type,
                }),
              ),
            },
          };
        }
        return {
          structuredContent: detail(
            args.model_id === "runtime/soul-model" ? "Soul 2" : "GPT Image 2",
          ),
        };
      },
    });
    expect(
      record.models.every((model) => !model.available && model.reason === "profile_invalid"),
    ).toBe(true);
    expect(listArgs.map((args) => args.after ?? null)).toEqual([
      null,
      "model-page-2",
      "model-page-3",
    ]);
    expect(listArgs.every((args) => args.cursor === undefined)).toBe(true);
  });

  test("fails closed when model catalog repeats a next_page_token", async () => {
    let listCalls = 0;
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (_name, args) => {
        if (args.action === "search") return { structuredContent: { models: [] } };
        if (args.action === "list") {
          listCalls += 1;
          return {
            structuredContent: {
              models: [detail("Soul 2"), detail("GPT Image 2")],
              next_page_token: "duplicate-page",
            },
          };
        }
        return {
          structuredContent: detail(
            args.model_id === "runtime/soul-model" ? "Soul 2" : "GPT Image 2",
          ),
        };
      },
    });
    expect(listCalls).toBe(2);
    expect(
      record.models.every((model) => !model.available && model.reason === "profile_invalid"),
    ).toBe(true);
  });

  test("uses soul_v2 directly despite the live catalog's similarly named Soul candidates", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (args.action === "get") {
          return {
            structuredContent:
              args.model_id === "soul_v2"
                ? canonicalDetail("Soul 2")
                : canonicalDetail("GPT Image 2"),
          };
        }
        if (args.action === "search" && String(args.query).includes("Soul")) {
          return {
            structuredContent: {
              models: [
                {
                  id: "soul_2",
                  name: "Higgsfield Soul 2.0",
                  provider_name: "Higgsfield",
                  output_type: "image",
                },
                {
                  id: "soul_cinematic",
                  name: "Soul Cinema",
                  provider_name: "Higgsfield",
                  output_type: "image",
                },
                {
                  id: "soul_v2",
                  name: "Higgsfield Soul 2.0",
                  provider_name: "Higgsfield",
                  output_type: "image",
                },
              ],
            },
          };
        }
        return { structuredContent: { models: [] } };
      },
    });
    expect(record.models.every((model) => model.available)).toBe(true);
    expect(record.models.map((model) => model.modelId)).toEqual([
      "soul_v2",
      "gpt_image_2",
    ]);
    expect(calls.map((call) => call.args)).toEqual([
      { action: "get", model_id: "soul_v2" },
      { action: "get", model_id: "gpt_image_2" },
    ]);
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["models_explore"]));
  });

  test("fails closed when dynamic media or detail option mappings are ambiguous", async () => {
    const incompatibleTools = structuredClone(tools);
    const generate = incompatibleTools.find((tool) => tool.name === "generate_image")!;
    const secondBranch = generate.inputSchema.properties.params.anyOf[1];
    secondBranch.properties.medias.items.properties.role.enum = ["different-role"];
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools: incompatibleTools }),
      callTool: async (_name, args) => {
        if (args.action === "search") {
          const model = detail(String(args.query).includes("Soul") ? "Soul 2" : "GPT Image 2");
          return { structuredContent: { models: [model] } };
        }
        const model = canonicalDetail(
          args.model_id === "soul_v2" ? "Soul 2" : "GPT Image 2",
        );
        if (!Array.isArray(model.parameters) || !Array.isArray(model.aspect_ratios)) {
          throw new Error("invalid test fixture");
        }
        model.parameters.push({ name: "duplicate_aspect", options: [...model.aspect_ratios] });
        return { structuredContent: model };
      },
    });
    expect(
      record.models.every((model) => !model.available && model.reason === "profile_invalid"),
    ).toBe(true);
  });

  test("fails closed when the soul_v2 detail ID is missing or mismatched", async () => {
    for (const soulContent of [{}, soulDetail("soul_2")]) {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const record = await inspectHiggsfieldProvider({
        now: NOW,
        listTools: async () => ({ tools }),
        callTool: async (name, args) => {
          calls.push({ name, args });
          if (args.action === "get" && args.model_id === "soul_v2") {
            return { structuredContent: soulContent };
          }
          if (args.action === "get") {
            return { structuredContent: canonicalDetail("GPT Image 2") };
          }
          if (args.action === "search" && args.query === "Higgsfield Soul V2") {
            return {
              structuredContent: {
                models: [
                  { id: "soul_2", name: "Higgsfield Soul 2.0" },
                  { id: "soul_cinematic", name: "Soul Cinema" },
                  { id: "soul_v2", name: "Higgsfield Soul 2.0" },
                ],
              },
            };
          }
          return { structuredContent: { models: [] } };
        },
      });
      expect(record.models[0]).toMatchObject({ available: false, reason: "profile_invalid" });
      expect(record.models[1]).toMatchObject({ available: true, modelId: "gpt_image_2" });
      expect(calls.filter((call) => call.args.action === "get")).toHaveLength(2);
      expect(calls.some((call) => call.args.model_id === "soul_2")).toBe(false);
      expect(calls.some((call) => call.args.model_id === "soul_cinematic")).toBe(false);
      expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["models_explore"]));
    }
  });

  test("does not promote the first alias when canonical get fails", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const record = await inspectHiggsfieldProvider({
      now: NOW,
      listTools: async () => ({ tools }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (args.action === "get" && args.model_id === "soul_v2") {
          throw new HiggsfieldMcpError("provider_failure");
        }
        if (args.action === "get") {
          return { structuredContent: canonicalDetail("GPT Image 2") };
        }
        if (args.action === "search" && args.query === "Higgsfield Soul V2") {
          return {
            structuredContent: {
              models: [
                {
                  ...soulDetail("soul_2"),
                  name: "Higgsfield Soul 2.0",
                },
                {
                  ...soulDetail("soul_cinematic"),
                  name: "Soul Cinema",
                },
                {
                  ...soulDetail("soul_v2"),
                  name: "Higgsfield Soul 2.0",
                },
              ],
            },
          };
        }
        return { structuredContent: { models: [] } };
      },
    });
    expect(record.models[0]).toMatchObject({ available: false, reason: "profile_invalid" });
    expect(record.models[1]).toMatchObject({ available: true });
    expect(calls.some((call) => call.args.model_id === "soul_2")).toBe(false);
    expect(calls.some((call) => call.args.model_id === "soul_cinematic")).toBe(false);
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["models_explore"]));
  });

  test("rejects every MCP tool outside the fixed read/upload/generate/status allowlist", async () => {
    await expect(
      callHiggsfieldMcpTool({
        session,
        name: "delete_account" as never,
        args: {},
      }),
    ).rejects.toMatchObject({ reason: "capability_required" });
  });

  test("maps Soul UI 1080p to canonical MCP quality 2k for the explicit generation attempt", async () => {
    const fingerprint = "generation-session";
    await seed(fingerprint);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const jobs = await createHiggsfieldGeneration({
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 2,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      confirmationToken: "request-generation-0001",
      env: GENERATION_ENV,
      callTool: async (name, args) => {
        calls.push({ name, args });
        return {
          results: ["provider-job-1", "provider-job-2"].map((id) => ({
            id,
            model: "soul_v2",
            status: "queued",
          })),
        };
      },
      now: NOW,
    });
    expect(jobs).toEqual([
      expect.objectContaining({ id: "provider-job-1", status: "queued" }),
      expect.objectContaining({ id: "provider-job-2", status: "queued" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("generate_image");
    expect(calls[0]?.args).toEqual({
      params: {
        model: "soul_v2",
        prompt: "one person in a studio",
        count: 2,
        aspect_ratio: "1:1",
        quality: "2k",
        medias: [],
      },
    });
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("classifies explicit generation credit and provider errors before results without retry", async () => {
    for (const scenario of [
      {
        fingerprint: "generation-credit-error-session",
        requestId: "request-credit-error-0001",
        providerError: "insufficient credit balance token=private-provider-token",
        expectedCode: "insufficient_credits",
      },
      {
        fingerprint: "generation-provider-error-session",
        requestId: "request-provider-error-0001",
        providerError: "provider rejected prompt at https://private.example/result",
        expectedCode: "provider_failure",
      },
    ]) {
      await seed(scenario.fingerprint);
      let creates = 0;
      const diagnostics: unknown[] = [];
      const error = await capturedError(() =>
        createHiggsfieldGeneration({
          fingerprint: scenario.fingerprint,
          session,
          jobSetType: "text2image_soul_v2",
          params: {
            prompt: "one person in a studio",
            batch_size: 1,
            aspect_ratio: "1:1",
            quality: "1080p",
            medias: [],
          },
          confirmationToken: scenario.requestId,
          env: GENERATION_ENV,
          callTool: async () => {
            creates += 1;
            const content = {
              request_id: "safe-provider-request-1",
              error: scenario.providerError,
              results: [{ id: "ignored-job", model: "soul_v2", status: "queued" }],
            };
            return scenario.expectedCode === "insufficient_credits"
              ? { isError: true, structuredContent: content }
              : content;
          },
          onGenerationDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          now: NOW,
        }),
      );
      expect(error).toMatchObject({ code: scenario.expectedCode });
      expect(JSON.stringify(error)).not.toContain(scenario.providerError);
      expect(JSON.stringify(error)).not.toContain("private-provider-token");
      expect(JSON.stringify(error)).not.toContain("private.example");
      expect(creates).toBe(1);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          generationStage: "generate_image",
          providerErrorPresent: true,
          resultCount: 1,
          jobIdPresent: true,
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("safe-provider-request-1");
      await clearGenerationRuntime(scenario.fingerprint, GENERATION_ENV);
      clearHiggsfieldRuntime(scenario.fingerprint);
    }
  });

  test("accepts one structured queued job with validated model lineage", async () => {
    const fingerprint = "generation-structured-success-session";
    await seed(fingerprint);
    let creates = 0;
    const diagnostics: unknown[] = [];
    const jobs = await createHiggsfieldGeneration({
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      confirmationToken: "request-structured-success-0001",
      env: GENERATION_ENV,
      callTool: async () => {
        creates += 1;
        return {
          structuredContent: {
            request_id: "safe-provider-request-2",
            results: [{ id: "provider-structured-1", model: "soul_v2", status: "queued" }],
          },
        };
      },
      onGenerationDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      now: NOW,
    });
    expect(jobs).toEqual([
      expect.objectContaining({ id: "provider-structured-1", status: "queued" }),
    ]);
    expect(creates).toBe(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        generationStage: "generate_image",
        providerErrorPresent: false,
        resultCount: 1,
        jobIdPresent: true,
      }),
    ]);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("accepts a standard MCP text content generation response", async () => {
    const fingerprint = "generation-text-content-success-session";
    await seed(fingerprint);
    let creates = 0;
    const jobs = await createHiggsfieldGeneration({
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      confirmationToken: "request-text-content-success-0001",
      env: GENERATION_ENV,
      callTool: async () => {
        creates += 1;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                request_id: "safe-text-request-1",
                results: [
                  { id: "provider-text-content-1", model: "soul_v2", status: "queued" },
                ],
              }),
            },
          ],
        };
      },
      now: NOW,
    });
    expect(jobs).toEqual([
      expect.objectContaining({ id: "provider-text-content-1", status: "queued" }),
    ]);
    expect(creates).toBe(1);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("classifies an isError text content credit response without exposing provider text", async () => {
    const fingerprint = "generation-text-content-credit-session";
    await seed(fingerprint);
    let creates = 0;
    const providerMessage =
      "insufficient credit balance token=private-text-token https://private.example/result";
    const error = await capturedError(() =>
      createHiggsfieldGeneration({
        fingerprint,
        session,
        jobSetType: "text2image_soul_v2",
        params: {
          prompt: "one person in a studio",
          batch_size: 1,
          aspect_ratio: "1:1",
          quality: "1080p",
          medias: [],
        },
        confirmationToken: "request-text-content-credit-0001",
        env: GENERATION_ENV,
        callTool: async () => {
          creates += 1;
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  request_id: "safe-text-request-2",
                  error: providerMessage,
                }),
              },
            ],
          };
        },
        now: NOW,
      }),
    );
    expect(error).toMatchObject({ code: "insufficient_credits", status: 402 });
    expect(JSON.stringify(error)).not.toContain(providerMessage);
    expect(JSON.stringify(error)).not.toContain("private-text-token");
    expect(JSON.stringify(error)).not.toContain("private.example");
    expect(creates).toBe(1);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("classifies bounded plain-text tool errors without retry or disclosure", async () => {
    for (const scenario of [
      {
        name: "credits",
        text: "Insufficient credit balance token=private-tool-token https://private.example/job",
        expectedCode: "insufficient_credits",
        expectedStatus: 402,
        rejectionClass: "credits",
      },
      {
        name: "validation",
        text: "Invalid required parameter prompt=private prompt file://private/path",
        expectedCode: "provider_failure",
        expectedStatus: 502,
        rejectionClass: "validation",
      },
    ] as const) {
      const fingerprint = `generation-plain-text-${scenario.name}-session`;
      await seed(fingerprint);
      let creates = 0;
      const diagnostics: unknown[] = [];
      const error = await capturedError(() =>
        createHiggsfieldGeneration({
          fingerprint,
          session,
          jobSetType: "text2image_soul_v2",
          params: {
            prompt: "one person in a studio",
            batch_size: 1,
            aspect_ratio: "1:1",
            quality: "1080p",
            medias: [],
          },
          confirmationToken: `request-plain-text-${scenario.name}-0001`,
          env: GENERATION_ENV,
          callTool: async () => {
            creates += 1;
            return {
              isError: true,
              content: [{ type: "text", text: scenario.text }],
            };
          },
          onGenerationDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          now: NOW,
        }),
      );
      expect(error).toMatchObject({ code: scenario.expectedCode, status: scenario.expectedStatus });
      expect(creates).toBe(1);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          generationStage: "generate_image",
          providerErrorPresent: false,
          toolErrorPresent: true,
          resultCount: 0,
          jobIdPresent: false,
          responseShape: "plain_text_error",
          rejectionClass: scenario.rejectionClass,
          parseFailure: "none",
        }),
      ]);
      const serialized = JSON.stringify({ error, diagnostics });
      expect(serialized).not.toContain(scenario.text);
      expect(serialized).not.toContain("private-tool-token");
      expect(serialized).not.toContain("private.example");
      expect(serialized).not.toContain("private prompt");
      expect(serialized).not.toContain("private/path");
      await clearGenerationRuntime(fingerprint, GENERATION_ENV);
      clearHiggsfieldRuntime(fingerprint);
    }
  });

  test("fails closed on malformed, oversized, or ambiguous text content without retry", async () => {
    const cases: Array<{
      name: string;
      content: Array<{ type: "text"; text: string }>;
      parseFailure: "malformed" | "oversized" | "ambiguous";
    }> = [
      {
        name: "malformed",
        content: [{ type: "text", text: '{"results":' }],
        parseFailure: "malformed",
      },
      {
        name: "oversized",
        content: [
          {
            type: "text",
            text: JSON.stringify({ padding: "x".repeat(HIGGSFIELD_MCP_MAX_RESPONSE_BYTES) }),
          },
        ],
        parseFailure: "oversized",
      },
      {
        name: "ambiguous",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: [{ id: "provider-ambiguous-1", model: "soul_v2", status: "queued" }],
            }),
          },
          {
            type: "text",
            text: JSON.stringify({
              results: [{ id: "provider-ambiguous-2", model: "soul_v2", status: "queued" }],
            }),
          },
        ],
        parseFailure: "ambiguous",
      },
    ];
    for (const scenario of cases) {
      const fingerprint = `generation-text-${scenario.name}-session`;
      await seed(fingerprint);
      let creates = 0;
      const diagnostics: unknown[] = [];
      const error = await capturedError(() =>
        createHiggsfieldGeneration({
          fingerprint,
          session,
          jobSetType: "text2image_soul_v2",
          params: {
            prompt: "one person in a studio",
            batch_size: 1,
            aspect_ratio: "1:1",
            quality: "1080p",
            medias: [],
          },
          confirmationToken: `request-text-${scenario.name}-0001`,
          env: GENERATION_ENV,
          callTool: async () => {
            creates += 1;
            return { content: scenario.content };
          },
          onGenerationDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          now: NOW,
        }),
      );
      expect(error).toMatchObject({ code: "outcome_unknown", status: 502 });
      expect(creates).toBe(1);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          toolErrorPresent: false,
          responseShape: "invalid",
          rejectionClass: "unknown",
          parseFailure: scenario.parseFailure,
        }),
      ]);
      await clearGenerationRuntime(fingerprint, GENERATION_ENV);
      clearHiggsfieldRuntime(fingerprint);
    }
  });

  test("keeps malformed or missing generation results outcome-unknown without retry", async () => {
    for (const [index, response] of [
      { structuredContent: { request_id: "safe-malformed-1" } },
      { structuredContent: { results: ["not-a-job"] } },
    ].entries()) {
      const fingerprint = `generation-malformed-session-${index}`;
      await seed(fingerprint);
      let creates = 0;
      const error = await capturedError(() =>
        createHiggsfieldGeneration({
          fingerprint,
          session,
          jobSetType: "text2image_soul_v2",
          params: {
            prompt: "one person in a studio",
            batch_size: 1,
            aspect_ratio: "1:1",
            quality: "1080p",
            medias: [],
          },
          confirmationToken: `request-malformed-${index}-0001`,
          env: GENERATION_ENV,
          callTool: async () => {
            creates += 1;
            return response;
          },
          now: NOW,
        }),
      );
      expect(error).toMatchObject({ code: "outcome_unknown", status: 502 });
      expect(creates).toBe(1);
      await clearGenerationRuntime(fingerprint, GENERATION_ENV);
      clearHiggsfieldRuntime(fingerprint);
    }
  });

  test("keeps the current MCP timeout and does not retry an uncertain timed-out create", async () => {
    const fingerprint = "generation-timeout-session";
    await seed(fingerprint);
    let creates = 0;
    expect(HIGGSFIELD_MCP_TIMEOUT_MS).toBe(25_000);
    const error = await capturedError(() =>
      createHiggsfieldGeneration({
        fingerprint,
        session,
        jobSetType: "text2image_soul_v2",
        params: {
          prompt: "one person in a studio",
          batch_size: 1,
          aspect_ratio: "1:1",
          quality: "1080p",
          medias: [],
        },
        confirmationToken: "request-timeout-0001",
        env: GENERATION_ENV,
        callTool: async () => {
          creates += 1;
          throw new HiggsfieldMcpError("timeout");
        },
        now: NOW,
      }),
    );
    expect(error).toMatchObject({ code: "outcome_unknown", status: 502 });
    expect(creates).toBe(1);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("rejects a structured generation from a different model without storing it", async () => {
    const fingerprint = "generation-model-mismatch-session";
    await seed(fingerprint);
    let creates = 0;
    const error = await capturedError(() =>
      createHiggsfieldGeneration({
        fingerprint,
        session,
        jobSetType: "text2image_soul_v2",
        params: {
          prompt: "one person in a studio",
          batch_size: 1,
          aspect_ratio: "1:1",
          quality: "1080p",
          medias: [],
        },
        confirmationToken: "request-model-mismatch-0001",
        env: GENERATION_ENV,
        callTool: async () => {
          creates += 1;
          return {
            structuredContent: {
              results: [
                { id: "provider-wrong-model-only", model: "soul_2", status: "queued" },
              ],
            },
          };
        },
        now: NOW,
      }),
    );
    expect(error).toMatchObject({ code: "job_mismatch", status: 502 });
    expect(creates).toBe(1);
    await expect(
      getHiggsfieldGeneration({
        fingerprint,
        session,
        jobId: "provider-wrong-model-only",
        env: GENERATION_ENV,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("blocks paid generation by default before generate_image is invoked", async () => {
    const fingerprint = "generation-disabled-session";
    await seed(fingerprint);
    let calls = 0;
    await expect(
      createHiggsfieldGeneration({
        fingerprint,
        session,
        jobSetType: "text2image_soul_v2",
        params: {
          prompt: "one person in a studio",
          batch_size: 1,
          aspect_ratio: "1:1",
          quality: "1080p",
          medias: [],
        },
        confirmationToken: "request-disabled-0001",
        env: { HDEX_GENERATION_ENABLED: "false" } as NodeJS.ProcessEnv,
        callTool: async () => {
          calls += 1;
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: "generation_disabled" });
    expect(calls).toBe(0);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("blocks enabled generation when the fail-closed TTL store is not configured", async () => {
    const fingerprint = "generation-store-missing-session";
    await seed(fingerprint);
    let creates = 0;
    await expect(
      createHiggsfieldGeneration({
        fingerprint,
        session,
        jobSetType: "text2image_soul_v2",
        params: {
          prompt: "one person in a studio",
          batch_size: 1,
          aspect_ratio: "1:1",
          quality: "1080p",
          medias: [],
        },
        confirmationToken: "request-store-missing-01",
        env: { HDEX_GENERATION_ENABLED: "true" } as NodeJS.ProcessEnv,
        callTool: async () => {
          creates += 1;
          return {};
        },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "generation_store_unavailable" });
    expect(creates).toBe(0);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("does not overwrite corrupt or unreadable generation state before create", async () => {
    const corruptFingerprint = "generation-store-corrupt-session";
    await seed(corruptFingerprint);
    const corruptFile = generationStateFile(corruptFingerprint);
    await mkdir(join(corruptFile, ".."), { recursive: true });
    const corruptContents = "{not-valid-json";
    await writeFile(corruptFile, corruptContents);
    let creates = 0;
    const common = {
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      env: GENERATION_ENV,
      callTool: async () => {
        creates += 1;
        return {};
      },
      now: NOW,
    };
    await expect(
      createHiggsfieldGeneration({
        ...common,
        fingerprint: corruptFingerprint,
        confirmationToken: "request-store-corrupt-01",
      }),
    ).rejects.toMatchObject({ code: "generation_store_corrupt" });
    expect(creates).toBe(0);
    expect(await readFile(corruptFile, "utf8")).toBe(corruptContents);

    const identityFingerprint = "generation-store-identity-session";
    await seed(identityFingerprint);
    const identityFile = generationStateFile(identityFingerprint);
    const identityContents = JSON.stringify({
      schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
      sessionFingerprint: "different-session",
      revocationToken: "initial",
      attempts: [],
      jobs: [],
      media: [],
    });
    await writeFile(identityFile, identityContents);
    await expect(
      createHiggsfieldGeneration({
        ...common,
        fingerprint: identityFingerprint,
        confirmationToken: "request-store-identity-01",
      }),
    ).rejects.toMatchObject({ code: "generation_store_corrupt" });
    expect(creates).toBe(0);
    expect(await readFile(identityFile, "utf8")).toBe(identityContents);

    const ioFingerprint = "generation-store-io-session";
    await seed(ioFingerprint);
    const blockedRoot = join(GENERATION_TEMP_DIR, "not-a-directory");
    const sentinel = "do-not-overwrite";
    await writeFile(blockedRoot, sentinel);
    await expect(
      createHiggsfieldGeneration({
        ...common,
        fingerprint: ioFingerprint,
        confirmationToken: "request-store-io-error-01",
        env: {
          HDEX_GENERATION_ENABLED: "true",
          HDEX_TEMP_DIR: blockedRoot,
          HDEX_TEMP_TTL_SECONDS: "3600",
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({ code: "generation_store_unavailable" });
    expect(creates).toBe(0);
    expect(await readFile(blockedRoot, "utf8")).toBe(sentinel);
    clearHiggsfieldRuntime(corruptFingerprint);
    clearHiggsfieldRuntime(identityFingerprint);
    clearHiggsfieldRuntime(ioFingerprint);
  });

  test("shares the first persisted load and recognizes an accepted claim without create", async () => {
    const fingerprint = "generation-first-load-session";
    await seed(fingerprint);
    const requestId = "request-first-load-0001";
    const providerParams = {
      model: "soul_v2",
      prompt: "one person in a studio",
      count: 1,
      aspect_ratio: "1:1",
      quality: "2k",
      medias: [],
    };
    const requestHash = generationRequestHash({
      jobSetType: "text2image_soul_v2",
      params: providerParams,
    });
    const file = generationStateFile(fingerprint);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
        sessionFingerprint: fingerprint,
        revocationToken: "initial",
        attempts: [
          {
            requestId,
            sessionFingerprint: fingerprint,
            requestHash,
            status: "accepted",
            providerJobIds: ["provider-existing-1"],
            createdAt: NOW,
            expiresAt: NOW + 3_600_000,
          },
        ],
        jobs: [
          {
            id: "provider-existing-1",
            providerJobId: "provider-existing-1",
            providerModelId: "soul_v2",
            jobSetType: "text2image_soul_v2",
            status: "queued",
            createdAt: NOW,
            expiresAt: NOW + 3_600_000,
            params: {
              prompt: "one person in a studio",
              batch_size: 1,
              aspect_ratio: "1:1",
              quality: "1080p",
              medias: [],
            },
          },
        ],
        media: [],
      }),
    );
    let creates = 0;
    const input = {
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      confirmationToken: requestId,
      env: GENERATION_ENV,
      callTool: async () => {
        creates += 1;
        return {};
      },
      now: NOW,
    };
    const [first, second] = await Promise.all([
      createHiggsfieldGeneration(input),
      createHiggsfieldGeneration(input),
    ]);
    expect(first).toEqual(second);
    expect(first[0]?.id).toBe("provider-existing-1");
    expect(creates).toBe(0);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("maps only media confirmed in the same OAuth session to the discovered role", async () => {
    const fingerprint = "generation-media-session";
    await seed(fingerprint);
    await registerGenerationMedia({
      sessionFingerprint: fingerprint,
      mediaId: "confirmed-media-1",
      env: GENERATION_ENV,
      now: NOW,
    });
    let providerParams: Record<string, unknown> | undefined;
    await createHiggsfieldGeneration({
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [{ id: "confirmed-media-1" }],
      },
      confirmationToken: "request-media-000001",
      env: GENERATION_ENV,
      callTool: async (_name, args) => {
        providerParams = args.params as Record<string, unknown>;
        return {
          results: [{ id: "provider-media-1", model: "soul_v2", status: "queued" }],
        };
      },
      now: NOW,
    });
    expect(providerParams?.medias).toEqual([{ role: "reference", value: "confirmed-media-1" }]);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("coalesces concurrent identical button attempts and polls only the known provider job", async () => {
    const fingerprint = "generation-dedup-session";
    await seed(fingerprint);
    let creates = 0;
    let statuses = 0;
    const params = {
      prompt: "one person in a studio",
      batch_size: 1,
      aspect_ratio: "1:1",
      quality: "1080p",
      medias: [],
    };
    const callTool = async (name: "generate_image" | "job_status") => {
      if (name === "job_status") {
        statuses += 1;
        return {
          generation: {
            id: "provider-dedup-1",
            status: "completed",
            results: { rawUrl: "https://cdn.higgsfield.ai/private/result" },
          },
        };
      }
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        results: [{ id: "provider-dedup-1", model: "soul_v2", status: "queued" }],
      };
    };
    const common = {
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params,
      env: GENERATION_ENV,
      callTool,
      now: NOW,
    };
    const [first, second] = await Promise.all([
      createHiggsfieldGeneration({ ...common, confirmationToken: "request-dedup-0001" }),
      createHiggsfieldGeneration({ ...common, confirmationToken: "request-dedup-0002" }),
    ]);
    expect(first).toEqual(second);
    expect(creates).toBe(1);
    const firstReplay = await createHiggsfieldGeneration({
      ...common,
      confirmationToken: "request-dedup-0001",
    });
    const secondReplay = await createHiggsfieldGeneration({
      ...common,
      confirmationToken: "request-dedup-0002",
    });
    expect(firstReplay).toEqual(secondReplay);
    expect(creates).toBe(1);
    const completed = await getHiggsfieldGeneration({
      fingerprint,
      session,
      jobId: "provider-dedup-1",
      callTool,
      env: GENERATION_ENV,
      now: NOW,
    });
    expect(completed).toMatchObject({
      status: "completed",
      result_url: "/api/higgsfield/result/provider-dedup-1",
    });
    expect(statuses).toBe(1);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("uses request ID as the primary idempotency key and permits a new explicit attempt", async () => {
    const fingerprint = "generation-request-id-session";
    await seed(fingerprint);
    let creates = 0;
    const base = {
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      env: GENERATION_ENV,
      callTool: async () => {
        creates += 1;
        return {
          results: [
            {
              id: `provider-explicit-${creates}`,
              model: "soul_v2",
              status: "queued",
            },
          ],
        };
      },
      now: NOW,
    };
    const first = await createHiggsfieldGeneration({
      ...base,
      confirmationToken: "request-primary-0001",
    });
    const replay = await createHiggsfieldGeneration({
      ...base,
      confirmationToken: "request-primary-0001",
    });
    expect(replay).toEqual(first);
    expect(creates).toBe(1);
    await expect(
      createHiggsfieldGeneration({
        ...base,
        params: { ...base.params, prompt: "a different paid request" },
        confirmationToken: "request-primary-0001",
      }),
    ).rejects.toMatchObject({ code: "generation_request_id_conflict" });
    expect(creates).toBe(1);
    const explicitSecond = await createHiggsfieldGeneration({
      ...base,
      confirmationToken: "request-primary-0002",
    });
    expect(explicitSecond[0]?.id).toBe("provider-explicit-2");
    expect(creates).toBe(2);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("stores only valid partial lineage and never exposes wrong, invalid, or duplicate jobs", async () => {
    const fingerprint = "generation-partial-session";
    await seed(fingerprint);
    let creates = 0;
    let statuses = 0;
    const params = {
      prompt: "one person in a studio",
      batch_size: 4,
      aspect_ratio: "1:1",
      quality: "1080p",
      medias: [],
    };
    await expect(
      createHiggsfieldGeneration({
        fingerprint,
        session,
        jobSetType: "text2image_soul_v2",
        params,
        confirmationToken: "request-partial-0001",
        env: GENERATION_ENV,
        callTool: async () => {
          creates += 1;
          return {
            results: [
              { id: "provider-observed-1", model: "soul_v2", status: "queued" },
              { id: "provider-wrong-model", model: "different-model", status: "queued" },
              { id: "provider-invalid-status", model: "soul_v2", status: "mystery" },
              { id: "provider-duplicate", model: "soul_v2", status: "queued" },
              { id: "provider-duplicate", model: "soul_v2", status: "queued" },
            ],
          };
        },
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: "outcome_unknown",
      data: {
        observedProviderJobIds: [
          "provider-observed-1",
          "provider-wrong-model",
          "provider-invalid-status",
          "provider-duplicate",
        ],
      },
    });
    expect(creates).toBe(1);
    const known = await getHiggsfieldGeneration({
      fingerprint,
      session,
      jobId: "provider-observed-1",
      callTool: async (name, args) => {
        expect(name).toBe("job_status");
        expect(args.jobId).toBe("provider-observed-1");
        statuses += 1;
        return { generation: { id: "provider-observed-1", status: "in_progress" } };
      },
      env: GENERATION_ENV,
      now: NOW,
    });
    expect(known).toMatchObject({ status: "in_progress", params });
    expect(statuses).toBe(1);
    for (const jobId of [
      "provider-wrong-model",
      "provider-invalid-status",
      "provider-duplicate",
      "unobserved-job",
    ]) {
      await expect(
        getHiggsfieldGeneration({
          fingerprint,
          session,
          jobId,
          callTool: async () => {
            statuses += 1;
            throw new Error("must not poll");
          },
          env: GENERATION_ENV,
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await getRemoteResultUrl(fingerprint, jobId, GENERATION_ENV)).toBeNull();
    }
    expect(statuses).toBe(1);
    const listed = await listHiggsfieldGenerations({
      fingerprint,
      env: GENERATION_ENV,
      now: NOW,
    });
    expect(listed.items.find((item) => item.id === "provider-observed-1")?.params).toEqual(params);
    expect(listed.items.map((item) => item.id)).toEqual(["provider-observed-1"]);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("uploads and confirms bytes without returning the signed URL to the browser", async () => {
    const fingerprint = "upload-session";
    await seed(fingerprint);
    const events: string[] = [];
    const result = await uploadHiggsfieldImage({
      session,
      fingerprint,
      filename: "pose.png",
      contentType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      callTool: async (name) => {
        events.push(name);
        if (name === "media_upload") {
          return {
            uploads: [
              {
                media_id: "personal-media-1",
                upload_url: "https://uploads.example/private?signed=secret",
                method: "PUT",
                content_type: "image/png",
              },
            ],
          };
        }
        return { results: [{ media_id: "personal-media-1", status: "  CoNfIrMeD \n" }] };
      },
      uploadFetch: async (_url, init) => {
        events.push("signed_put");
        expect(init?.redirect).toBe("error");
        expect(init?.body).toBeInstanceOf(Blob);
        return new Response(null, { status: 200 });
      },
      env: GENERATION_ENV,
    });
    expect(result).toEqual({ id: "personal-media-1", type: "image" });
    expect(JSON.stringify(result)).not.toMatch(/https:|signed|secret/);
    expect(events).toEqual(["media_upload", "signed_put", "media_confirm"]);
    expect(
      await hasGenerationMedia({
        sessionFingerprint: fingerprint,
        mediaIds: ["personal-media-1"],
        env: GENERATION_ENV,
      }),
    ).toBe(true);
    expect(
      await hasGenerationMedia({
        sessionFingerprint: "different-browser-session",
        mediaIds: ["personal-media-1"],
        env: GENERATION_ENV,
      }),
    ).toBe(false);
    await clearGenerationRuntime(fingerprint, GENERATION_ENV);
    clearHiggsfieldRuntime(fingerprint);
  });

  test("clears sealed cookies, capability cache, and generation TTL state after MCP 401/403", async () => {
    const fingerprint = "authentication-failure-session";
    await seed(fingerprint);
    await createHiggsfieldGeneration({
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      confirmationToken: "request-auth-failure-0001",
      env: GENERATION_ENV,
      callTool: async () => ({
        results: [{ id: "provider-auth-failure", model: "soul_v2", status: "queued" }],
      }),
      now: NOW,
    });
    const error = new HiggsfieldMcpError("authentication_failed");
    expect(isHiggsfieldAuthenticationFailure(error)).toBe(true);
    const headers = new Headers();
    await invalidateHiggsfieldAuthentication({
      headers,
      sessionFingerprint: fingerprint,
      env: GENERATION_ENV,
    });
    expect(getHiggsfieldCapabilitySummary(fingerprint, NOW)).toEqual({
      status: "not_checked",
      models: [],
    });
    expect(
      (await listHiggsfieldGenerations({ fingerprint, env: GENERATION_ENV, now: NOW })).items,
    ).toEqual([]);
    expect(headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("does not repopulate generation state from a create flight invalidated by reconnect", async () => {
    const fingerprint = "authentication-flight-session";
    await seed(fingerprint);
    let resolveCreate!: (value: Record<string, unknown>) => void;
    let enteredCreate!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredCreate = resolve;
    });
    const providerResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveCreate = resolve;
    });
    const create = createHiggsfieldGeneration({
      fingerprint,
      session,
      jobSetType: "text2image_soul_v2",
      params: {
        prompt: "one person in a studio",
        batch_size: 1,
        aspect_ratio: "1:1",
        quality: "1080p",
        medias: [],
      },
      confirmationToken: "request-auth-flight-0001",
      env: GENERATION_ENV,
      callTool: async () => {
        enteredCreate();
        return providerResponse;
      },
      now: NOW,
    });
    await entered;
    await invalidateHiggsfieldAuthentication({
      headers: new Headers(),
      sessionFingerprint: fingerprint,
      env: GENERATION_ENV,
    });
    resolveCreate({
      results: [{ id: "provider-after-reconnect", model: "soul_v2", status: "queued" }],
    });
    await expect(create).rejects.toMatchObject({ code: "oauth_required" });
    expect(
      (await listHiggsfieldGenerations({ fingerprint, env: GENERATION_ENV, now: NOW })).items,
    ).toEqual([]);
  });
});
