import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { HiggsfieldOAuthSession } from "./higgsfield-oauth.server";

export const HIGGSFIELD_MCP_TIMEOUT_MS = 25_000;
export const HIGGSFIELD_MCP_MAX_RESPONSE_BYTES = 1024 * 1024;
export const HIGGSFIELD_MCP_MAX_PAGES = 4;
export const HIGGSFIELD_MCP_MAX_TOOLS = 128;
export const HIGGSFIELD_MODEL_MAX_PAGES = 3;
export const HIGGSFIELD_MODEL_MAX_ITEMS = 300;
export const HIGGSFIELD_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1_000;

const MODEL_TARGETS = [
  {
    key: "soul_2",
    canonicalJobSetType: "text2image_soul_v2",
    searchName: "Higgsfield Soul V2",
    displayName: "Soul 2",
    providerName: "Higgsfield",
    aliases: ["Higgsfield Soul V2", "Soul V2", "Soul 2", "Soul 2.0"],
    aspects: ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"],
    resolution: "2k",
    qualities: [],
    maximumImages: 1,
  },
  {
    key: "gpt_image_2",
    canonicalJobSetType: "gpt_image_2",
    searchName: "GPT Image 2",
    displayName: "GPT Image 2",
    providerName: "OpenAI",
    aliases: ["GPT Image 2", "OpenAI GPT Image 2", "GPT Image 2 OpenAI"],
    aspects: ["9:16", "3:4", "2:3", "1:1", "4:3", "16:9"],
    resolution: "2k",
    qualities: ["high"],
    maximumImages: 4,
  },
] as const;
const REQUIRED_TOOLS = [
  "models_explore",
  "media_upload",
  "media_confirm",
  "generate_image",
  "job_status",
] as const;
export type HiggsfieldMcpToolName = (typeof REQUIRED_TOOLS)[number];

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export type DiscoveredTool = {
  name: string;
  inputSchema: JsonSchema;
};

export type DiscoveredModelProfile = {
  key: (typeof MODEL_TARGETS)[number]["key"];
  displayName: string;
  available: boolean;
  reason?: "model_missing" | "model_ambiguous" | "profile_invalid" | "tool_contract_invalid";
  modelId?: string;
  modelName?: string;
  parameterOptions?: Record<string, Array<string | number | boolean>>;
  aspectRatios?: string[];
  aspectRatioParameter?: string;
  resolutionParameter?: string;
  resolutionValue?: string | number | boolean;
  qualityParameter?: string;
  qualityValue?: string | number | boolean;
  mediaRole?: string;
  maximumImages?: number;
  inputContractHash?: string;
};

export type HiggsfieldCapabilityRecord = {
  checkedAt: number;
  expiresAt: number;
  toolCount: number;
  pageCount: number;
  tools: DiscoveredTool[];
  models: DiscoveredModelProfile[];
};

type CapabilityCacheEntry = { value: HiggsfieldCapabilityRecord; expiresAt: number };
const capabilityCache = new Map<string, CapabilityCacheEntry>();
const inspectionFlights = new Map<string, Promise<HiggsfieldCapabilityRecord>>();
const capabilityEpochs = new Map<string, number>();

export class HiggsfieldMcpError extends Error {
  constructor(
    public readonly reason:
      | "timeout"
      | "authentication_failed"
      | "rate_limited"
      | "provider_failure"
      | "response_limit"
      | "invalid_response"
      | "capability_required",
  ) {
    super(`higgsfield_mcp_${reason}`);
    this.name = "HiggsfieldMcpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max = 500): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })
    ? null
    : value;
}

function safeId(value: unknown): string | null {
  const text = safeText(value, 240);
  return text && /^[A-Za-z0-9._:/-]+$/.test(text) ? text : null;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function withoutProviderTokens(name: string, providerName?: string): string {
  const providerTokens = new Set(
    normalizeName(providerName ?? "")
      .split(" ")
      .filter(Boolean),
  );
  return normalizeName(name)
    .split(" ")
    .filter((token) => token !== "by" && !providerTokens.has(token))
    .join(" ");
}

function modelNameMatches(
  target: (typeof MODEL_TARGETS)[number],
  name: string,
  providerName?: string,
): boolean {
  const normalized = withoutProviderTokens(name, providerName);
  const aliases = target.aliases.map((alias) => withoutProviderTokens(alias, providerName));
  return aliases.includes(normalized);
}

function searchModelMatches(
  target: (typeof MODEL_TARGETS)[number],
  candidate: SearchModel,
): boolean {
  return (
    candidate.id === target.canonicalJobSetType ||
    modelNameMatches(target, candidate.name, candidate.providerName)
  );
}

function modelProviderMatches(
  target: (typeof MODEL_TARGETS)[number],
  providerName: string,
): boolean {
  return normalizeName(providerName) === normalizeName(target.providerName);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal | null): AbortSignal {
  if (!secondary) return primary;
  return AbortSignal.any([primary, secondary]);
}

async function boundedResponse(response: Response): Promise<Response> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > HIGGSFIELD_MCP_MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new HiggsfieldMcpError("response_limit");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      total += chunk.value.byteLength;
      if (total > HIGGSFIELD_MCP_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        controller.error(new HiggsfieldMcpError("response_limit"));
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function withOfficialMcpClient<T>(input: {
  mcpUrl: string;
  accessToken: string;
  operation: (client: Client, signal: AbortSignal) => Promise<T>;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const endpoint = new URL(input.mcpUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIGGSFIELD_MCP_TIMEOUT_MS);
  const restrictedFetch: typeof fetch = async (requestInput, init) => {
    const target = new URL(String(requestInput));
    if (target.toString() !== endpoint.toString()) {
      throw new HiggsfieldMcpError("provider_failure");
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${input.accessToken}`);
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(target, {
        ...init,
        headers,
        redirect: "error",
        cache: "no-store",
        signal: combineSignals(controller.signal, init?.signal),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new HiggsfieldMcpError("timeout");
      if (error instanceof HiggsfieldMcpError) throw error;
      throw new HiggsfieldMcpError("provider_failure");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new HiggsfieldMcpError("authentication_failed");
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new HiggsfieldMcpError("rate_limited");
    }
    return boundedResponse(response);
  };
  const client = new Client(
    { name: "hdex-influencer-frame", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: restrictedFetch,
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  try {
    await client.connect(transport, {
      signal: controller.signal,
      timeout: HIGGSFIELD_MCP_TIMEOUT_MS,
      maxTotalTimeout: HIGGSFIELD_MCP_TIMEOUT_MS,
    });
    return await input.operation(client, controller.signal);
  } catch (error) {
    if (error instanceof HiggsfieldMcpError) throw error;
    if (controller.signal.aborted) throw new HiggsfieldMcpError("timeout");
    throw new HiggsfieldMcpError("invalid_response");
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

function normalizeTool(value: unknown): DiscoveredTool | null {
  if (!isRecord(value) || !safeText(value.name, 128) || !isRecord(value.inputSchema)) return null;
  return { name: value.name as string, inputSchema: value.inputSchema as JsonSchema };
}

function schemaBranches(schema: JsonSchema | undefined): JsonSchema[] {
  if (!schema) return [];
  return schema.anyOf ?? schema.oneOf ?? [schema];
}

function executableObjectBranches(schema: JsonSchema | undefined): JsonSchema[] {
  return schemaBranches(schema).filter(
    (branch) => hasType(branch, "object") || branch.properties !== undefined,
  );
}

function branchProperties(root: JsonSchema, branch: JsonSchema): Record<string, JsonSchema> {
  return { ...(root.properties ?? {}), ...(branch.properties ?? {}) };
}

function hasType(schema: JsonSchema | undefined, expected: string): boolean {
  return (
    schema?.type === expected || (Array.isArray(schema?.type) && schema.type.includes(expected))
  );
}

function enumIncludes(schema: JsonSchema | undefined, expected: string): boolean {
  return Array.isArray(schema?.enum) && schema.enum.includes(expected);
}

function toolContractValid(tool: DiscoveredTool): boolean {
  const properties = tool.inputSchema.properties;
  if (!hasType(tool.inputSchema, "object") || !properties) return false;
  if (tool.name === "models_explore") {
    return (
      hasType(properties.action, "string") &&
      enumIncludes(properties.action, "search") &&
      enumIncludes(properties.action, "get") &&
      enumIncludes(properties.action, "list")
    );
  }
  if (tool.name === "media_upload") {
    const files = properties.files;
    return (
      hasType(properties.method, "string") &&
      hasType(files, "array") &&
      hasType(files.items, "object") &&
      hasType(files.items?.properties?.filename, "string") &&
      hasType(files.items?.properties?.content_type, "string")
    );
  }
  if (tool.name === "media_confirm") {
    return (
      hasType(properties.media_ids, "array") &&
      hasType(properties.media_ids.items, "string") &&
      hasType(properties.type, "string")
    );
  }
  if (tool.name === "job_status") return hasType(properties.jobId, "string");
  if (tool.name === "generate_image") {
    const params = properties.params;
    return Boolean(params && executableObjectBranches(params).length > 0);
  }
  return true;
}

function structuredContent(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HiggsfieldMcpError("invalid_response");
  if (value.isError === true) throw new HiggsfieldMcpError("provider_failure");
  if (isRecord(value.structuredContent)) return value.structuredContent;
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      if (Buffer.byteLength(item.text) > HIGGSFIELD_MCP_MAX_RESPONSE_BYTES) {
        throw new HiggsfieldMcpError("response_limit");
      }
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        continue;
      }
    }
  }
  throw new HiggsfieldMcpError("invalid_response");
}

type SearchModel = {
  id: string;
  name: string;
  providerName?: string;
  outputType?: string;
  raw: Record<string, unknown>;
};

function modelItems(value: unknown): SearchModel[] {
  const content = structuredContent(value);
  const arrays = [content.items, content.models, content.results, content.data].filter(
    Array.isArray,
  );
  const source = arrays[0] ?? [];
  return source.slice(0, 100).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = safeId(item.id ?? item.model_id);
    const name = safeText(item.name ?? item.display_name, 240);
    const providerName = safeText(item.provider_name, 240) ?? undefined;
    const outputType = safeText(item.output_type, 40) ?? undefined;
    return id && name
      ? [
          {
            id,
            name,
            ...(providerName ? { providerName } : {}),
            ...(outputType ? { outputType } : {}),
            raw: item,
          },
        ]
      : [];
  });
}

function nextModelPage(value: unknown): { nextPageToken?: string; valid: boolean } {
  const content = structuredContent(value);
  if (content.next_page_token === undefined || content.next_page_token === null) {
    return { valid: true };
  }
  const token = safeText(content.next_page_token, 500);
  return token && token.trim() ? { nextPageToken: token, valid: true } : { valid: false };
}

function detailRecordFromContent(
  content: Record<string, unknown>,
  expectedId: string,
): Record<string, unknown> | null {
  const directId = safeId(content.id ?? content.model_id);
  if (directId === expectedId) return content;
  const arrays = [content.items, content.models, content.results, content.data].filter(
    Array.isArray,
  );
  const matching = (arrays[0] ?? []).filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) && safeId(item.id ?? item.model_id) === expectedId,
  );
  return matching.length === 1 ? matching[0]! : null;
}

function observedDetailRecord(content: Record<string, unknown>): Record<string, unknown> | undefined {
  if (
    Object.hasOwn(content, "id") ||
    Object.hasOwn(content, "model_id") ||
    Object.hasOwn(content, "job_set_type")
  ) {
    return content;
  }
  const arrays = [content.items, content.models, content.results, content.data].filter(
    Array.isArray,
  );
  return (arrays[0] ?? []).find(isRecord);
}

function parameterOptions(
  detail: Record<string, unknown>,
): Record<string, Array<string | number | boolean>> {
  if (!Array.isArray(detail.parameters)) return {};
  const result: Record<string, Array<string | number | boolean>> = {};
  for (const item of detail.parameters.slice(0, 80)) {
    if (!isRecord(item)) continue;
    const name = safeText(item.name, 128);
    if (!name || !Array.isArray(item.options)) continue;
    const options = item.options.filter(
      (option): option is string | number | boolean =>
        (typeof option === "string" && option.length <= 200) ||
        (typeof option === "number" && Number.isFinite(option)) ||
        typeof option === "boolean",
    );
    if (options.length > 0) result[name] = options.slice(0, 64);
  }
  return result;
}

function mediaContract(detail: Record<string, unknown>): { role?: string; maximumImages?: number } {
  if (!Array.isArray(detail.medias)) return {};
  const slots = detail.medias.slice(0, 16).flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.roles)) return [];
    const roles = item.roles
      .map((role) => safeText(role, 128))
      .filter((role): role is string => Boolean(role));
    const maximum =
      Number.isSafeInteger(item.max) && Number(item.max) >= 0 ? Number(item.max) : undefined;
    return roles.length === 1 ? [{ role: roles[0]!, maximum }] : [];
  });
  const roles = new Set(slots.map((slot) => slot.role));
  if (roles.size !== 1) return {};
  const maximums = slots.flatMap((slot) => (slot.maximum === undefined ? [] : [slot.maximum]));
  return {
    role: [...roles][0],
    ...(maximums.length > 0 ? { maximumImages: Math.min(...maximums, 16) } : {}),
  };
}

function scalarExecutionContract(schema: JsonSchema | undefined): string | null {
  if (!schema || !hasType(schema, "string")) return null;
  return stableJson({
    type: schema.type,
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.const !== undefined ? { const: schema.const } : {}),
    ...(schema.minLength !== undefined ? { minLength: schema.minLength } : {}),
    ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
    ...(schema.pattern !== undefined ? { pattern: schema.pattern } : {}),
  });
}

function schemaAllowsRole(schema: JsonSchema, role: string): boolean {
  if (!hasType(schema, "string") || schema.pattern !== undefined) return false;
  if (schema.enum && !schema.enum.includes(role)) return false;
  if (schema.const !== undefined && schema.const !== role) return false;
  return true;
}

function toolMediaContract(
  generateTool: DiscoveredTool,
  role: string,
): { maximumImages: number } | null {
  const params = generateTool.inputSchema.properties?.params;
  if (!params) return null;
  const branches = executableObjectBranches(params);
  if (branches.length === 0) return null;
  let itemContract: string | null = null;
  const maximums: number[] = [];
  for (const branch of branches) {
    const medias = branchProperties(params, branch).medias;
    const items = medias?.items;
    const roleSchema = items?.properties?.role;
    const valueSchema = items?.properties?.value;
    const required = items?.required;
    const currentContract = stableJson({
      role: scalarExecutionContract(roleSchema),
      value: scalarExecutionContract(valueSchema),
      additionalProperties: items?.additionalProperties ?? null,
    });
    if (
      !hasType(medias, "array") ||
      !hasType(items, "object") ||
      !Array.isArray(required) ||
      required.length !== 2 ||
      !required.includes("role") ||
      !required.includes("value") ||
      !scalarExecutionContract(roleSchema) ||
      !scalarExecutionContract(valueSchema) ||
      !schemaAllowsRole(roleSchema!, role) ||
      (medias?.minItems !== undefined &&
        (!Number.isSafeInteger(medias.minItems) || medias.minItems < 0 || medias.minItems > 1)) ||
      (medias?.maxItems !== undefined &&
        (!Number.isSafeInteger(medias.maxItems) || medias.maxItems < 1)) ||
      (itemContract !== null && itemContract !== currentContract)
    )
      return null;
    itemContract = currentContract;
    if (medias?.maxItems !== undefined) maximums.push(medias.maxItems);
  }
  return { maximumImages: Math.min(...(maximums.length ? maximums : [16]), 16) };
}

function toolAspectParameter(generateTool: DiscoveredTool): string | null {
  const params = generateTool.inputSchema.properties?.params;
  if (!params) return null;
  const branches = executableObjectBranches(params);
  if (
    branches.length === 0 ||
    branches.some((branch) => !hasType(branchProperties(params, branch).aspect_ratio, "string"))
  )
    return null;
  return "aspect_ratio";
}

function optionOwners(
  parameters: Record<string, Array<string | number | boolean>>,
  requiredValues: readonly string[],
): Set<string> | null {
  const owners = requiredValues.map((required) =>
    Object.entries(parameters).flatMap(([parameter, options]) =>
      options.some((option) => String(option).toLowerCase() === required.toLowerCase())
        ? [parameter]
        : [],
    ),
  );
  if (owners.some((matching) => matching.length !== 1)) return null;
  return new Set(owners.flat());
}

function productInputMappings(input: {
  target: (typeof MODEL_TARGETS)[number];
  parameters: Record<string, Array<string | number | boolean>>;
  aspectRatios: string[];
  media: { role?: string; maximumImages?: number };
  generateTool: DiscoveredTool;
}): {
  aspectRatioParameter: string;
  resolutionParameter: string;
  resolutionValue: string | number | boolean;
  qualityParameter?: string;
  qualityValue?: string | number | boolean;
  maximumImages: number;
} | null {
  const advertisedAspects = new Set(input.aspectRatios.map((value) => value.toLowerCase()));
  if (!input.target.aspects.every((value) => advertisedAspects.has(value.toLowerCase())))
    return null;
  const aspectOwners = optionOwners(input.parameters, input.target.aspects);
  const aspectRatioParameter =
    aspectOwners?.size === 1 ? [...aspectOwners][0]! : toolAspectParameter(input.generateTool);
  const resolutionOwners = optionOwners(input.parameters, [input.target.resolution]);
  const qualityOwners =
    input.target.qualities.length > 0
      ? optionOwners(input.parameters, input.target.qualities)
      : new Set<string>();
  if (!aspectRatioParameter || !resolutionOwners || resolutionOwners.size !== 1) return null;
  if (
    !qualityOwners ||
    qualityOwners.size > 1 ||
    !input.media.role ||
    (input.media.maximumImages !== undefined &&
      input.media.maximumImages < input.target.maximumImages)
  )
    return null;
  const resolutionParameter = [...resolutionOwners][0]!;
  const qualityParameter = qualityOwners.size === 1 ? [...qualityOwners][0]! : undefined;
  const semanticParameters = new Set([
    aspectRatioParameter,
    resolutionParameter,
    ...(qualityParameter ? [qualityParameter] : []),
  ]);
  if (semanticParameters.size !== (input.target.qualities.length > 0 ? 3 : 2)) return null;
  const resolutionValue = input.parameters[resolutionParameter]?.find(
    (value) => String(value).toLowerCase() === input.target.resolution.toLowerCase(),
  );
  const qualityValue = qualityParameter
    ? input.parameters[qualityParameter]?.find(
        (value) => String(value).toLowerCase() === input.target.qualities[0]?.toLowerCase(),
      )
    : undefined;
  if (resolutionValue === undefined || (qualityParameter && qualityValue === undefined))
    return null;
  const schemaMedia = toolMediaContract(input.generateTool, input.media.role);
  const maximumImages = Math.min(
    input.target.maximumImages,
    input.media.maximumImages ?? input.target.maximumImages,
    schemaMedia?.maximumImages ?? 0,
  );
  if (!schemaMedia || maximumImages !== input.target.maximumImages) return null;
  return {
    aspectRatioParameter,
    resolutionParameter,
    resolutionValue,
    ...(qualityParameter && qualityValue !== undefined ? { qualityParameter, qualityValue } : {}),
    maximumImages,
  };
}

function modelIdentity(target: (typeof MODEL_TARGETS)[number]) {
  return { key: target.key, displayName: target.displayName };
}

function buildModelProfile(input: {
  target: (typeof MODEL_TARGETS)[number];
  candidate: SearchModel;
  detail?: Record<string, unknown>;
  generateTool?: DiscoveredTool;
}): DiscoveredModelProfile {
  if (!input.detail) {
    return { ...modelIdentity(input.target), available: false, reason: "profile_invalid" };
  }
  if (!input.generateTool || !toolContractValid(input.generateTool)) {
    return { ...modelIdentity(input.target), available: false, reason: "tool_contract_invalid" };
  }
  const id = safeId(input.detail.id ?? input.detail.model_id);
  const detailName = safeText(input.detail.name ?? input.detail.display_name, 240);
  const detailProviderName = safeText(input.detail.provider_name, 240) ?? undefined;
  const detailOutputType = safeText(input.detail.output_type, 40) ?? undefined;
  const providerConflict =
    input.candidate.providerName &&
    detailProviderName &&
    normalizeName(input.candidate.providerName) !== normalizeName(detailProviderName);
  const outputConflict =
    input.candidate.outputType &&
    detailOutputType &&
    normalizeName(input.candidate.outputType) !== normalizeName(detailOutputType);
  const providerName = detailProviderName ?? input.candidate.providerName;
  const outputType = detailOutputType ?? input.candidate.outputType;
  const canonicalIdentity = id === input.target.canonicalJobSetType;
  const name = detailName ?? input.candidate.name;
  if (
    !id ||
    id !== input.candidate.id ||
    providerConflict ||
    outputConflict ||
    (providerName !== undefined && !modelProviderMatches(input.target, providerName)) ||
    (outputType !== undefined && normalizeName(outputType) !== "image") ||
    (!canonicalIdentity &&
      (!providerName || !outputType || !modelNameMatches(input.target, name, providerName)))
  ) {
    return { ...modelIdentity(input.target), available: false, reason: "profile_invalid" };
  }
  const parameters = parameterOptions(input.detail);
  const aspectRatios = Array.isArray(input.detail.aspect_ratios)
    ? input.detail.aspect_ratios
        .map((value) => safeText(value, 32))
        .filter((value): value is string => Boolean(value))
    : [];
  const media = mediaContract(input.detail);
  const mappings = productInputMappings({
    target: input.target,
    parameters,
    aspectRatios,
    media,
    generateTool: input.generateTool,
  });
  if (!mappings) {
    return { ...modelIdentity(input.target), available: false, reason: "profile_invalid" };
  }
  const contract = {
    generateImage: input.generateTool.inputSchema,
    model: {
      id,
      parameters,
      aspectRatios,
      media,
      mappings,
    },
  };
  return {
    ...modelIdentity(input.target),
    available: true,
    modelId: id,
    modelName: name,
    parameterOptions: parameters,
    aspectRatios,
    aspectRatioParameter: mappings.aspectRatioParameter,
    resolutionParameter: mappings.resolutionParameter,
    resolutionValue: mappings.resolutionValue,
    ...(mappings.qualityParameter ? { qualityParameter: mappings.qualityParameter } : {}),
    ...(mappings.qualityValue !== undefined ? { qualityValue: mappings.qualityValue } : {}),
    mediaRole: media.role,
    maximumImages: mappings.maximumImages,
    inputContractHash: `sha256:${createHash("sha256").update(stableJson(contract)).digest("hex")}`,
  };
}

type ModelProfileRejectionCode =
  | "canonical_detail_missing"
  | "canonical_identity_mismatch"
  | "provider_conflict"
  | "output_conflict"
  | "parameter_contract_missing"
  | "aspect_mapping_invalid"
  | "quality_2k_mapping_invalid"
  | "media_contract_invalid"
  | "generate_schema_incompatible";

function safeDiagnosticText(value: unknown, max = 160): string | undefined {
  const text = safeText(value, max) ?? undefined;
  if (
    !text ||
    /(?:authorization|bearer|cookie|secret|token)/iu.test(text) ||
    /[a-z][a-z0-9+.-]*:|\bwww\./iu.test(text)
  ) {
    return undefined;
  }
  return text;
}

function safeDiagnosticId(value: unknown): string | undefined {
  const id = safeId(value) ?? undefined;
  return id && safeDiagnosticText(id, 160) ? id : undefined;
}

function diagnoseSoulProfileRejection(input: {
  target: (typeof MODEL_TARGETS)[number];
  observedDetail?: Record<string, unknown>;
  canonicalDetail?: Record<string, unknown>;
  generateTool?: DiscoveredTool;
}): ModelProfileRejectionCode {
  if (!input.observedDetail) return "canonical_detail_missing";
  const hasIdentity = ["id", "model_id", "job_set_type"].some((key) =>
    Object.hasOwn(input.observedDetail!, key),
  );
  if (!hasIdentity) return "canonical_detail_missing";
  if (
    !input.canonicalDetail ||
    safeId(input.canonicalDetail.id ?? input.canonicalDetail.model_id) !==
      input.target.canonicalJobSetType
  ) {
    return "canonical_identity_mismatch";
  }
  const providerName = safeText(input.canonicalDetail.provider_name, 240) ?? undefined;
  if (providerName !== undefined && !modelProviderMatches(input.target, providerName)) {
    return "provider_conflict";
  }
  const outputType = safeText(input.canonicalDetail.output_type, 40) ?? undefined;
  if (outputType !== undefined && normalizeName(outputType) !== "image") {
    return "output_conflict";
  }
  const parameters = parameterOptions(input.canonicalDetail);
  if (!Array.isArray(input.canonicalDetail.parameters) || Object.keys(parameters).length === 0) {
    return "parameter_contract_missing";
  }
  const aspectRatios = Array.isArray(input.canonicalDetail.aspect_ratios)
    ? input.canonicalDetail.aspect_ratios
        .map((value) => safeText(value, 32))
        .filter((value): value is string => Boolean(value))
    : [];
  const advertisedAspects = new Set(aspectRatios.map((value) => value.toLowerCase()));
  const aspectOwners = optionOwners(parameters, input.target.aspects);
  const aspectRatioParameter =
    aspectOwners?.size === 1
      ? [...aspectOwners][0]!
      : input.generateTool
        ? toolAspectParameter(input.generateTool)
        : null;
  if (
    !input.target.aspects.every((value) => advertisedAspects.has(value.toLowerCase())) ||
    !aspectRatioParameter
  ) {
    return "aspect_mapping_invalid";
  }
  const resolutionOwners = optionOwners(parameters, [input.target.resolution]);
  if (
    !resolutionOwners ||
    resolutionOwners.size !== 1 ||
    [...resolutionOwners][0] === aspectRatioParameter
  ) {
    return "quality_2k_mapping_invalid";
  }
  const media = mediaContract(input.canonicalDetail);
  if (
    !media.role ||
    (media.maximumImages !== undefined && media.maximumImages < input.target.maximumImages)
  ) {
    return "media_contract_invalid";
  }
  if (
    !input.generateTool ||
    !toolContractValid(input.generateTool) ||
    !toolMediaContract(input.generateTool, media.role) ||
    !productInputMappings({
      target: input.target,
      parameters,
      aspectRatios,
      media,
      generateTool: input.generateTool,
    })
  ) {
    return "generate_schema_incompatible";
  }
  return "generate_schema_incompatible";
}

function diagnosticIdentityField(detail: Record<string, unknown> | undefined, key: string) {
  const present = Boolean(detail && Object.hasOwn(detail, key));
  const value = present ? safeDiagnosticId(detail?.[key]) : undefined;
  return { present, ...(value ? { value } : {}) };
}

function diagnosticParameters(detail: Record<string, unknown> | undefined) {
  if (!Array.isArray(detail?.parameters)) return [];
  return detail.parameters.slice(0, 24).flatMap((parameter) => {
    if (!isRecord(parameter)) return [];
    const name = safeDiagnosticText(parameter.name, 96);
    if (!name) return [];
    const values = Array.isArray(parameter.options)
      ? parameter.options
      : Array.isArray(parameter.enum)
        ? parameter.enum
        : [];
    const enumValues: Array<string | number | boolean> = [];
    for (const value of values.slice(0, 32)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        enumValues.push(value);
        continue;
      }
      if (typeof value === "boolean") {
        enumValues.push(value);
        continue;
      }
      const text = safeDiagnosticText(value, 96);
      if (text !== undefined) enumValues.push(text);
    }
    return [{ name, enumValues }];
  });
}

function diagnosticMedia(detail: Record<string, unknown> | undefined) {
  if (!Array.isArray(detail?.medias)) return [];
  return detail.medias.slice(0, 8).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const roles = Array.isArray(entry.roles)
      ? entry.roles
          .slice(0, 8)
          .flatMap((role) => (safeDiagnosticText(role, 96) ? [safeDiagnosticText(role, 96)!] : []))
      : [];
    const maximum =
      Number.isSafeInteger(entry.max) && Number(entry.max) >= 0 && Number(entry.max) <= 10_000
        ? Number(entry.max)
        : undefined;
    return [{ roles, ...(maximum !== undefined ? { max: maximum } : {}) }];
  });
}

function logSoulProfileDiagnostic(input: {
  target: (typeof MODEL_TARGETS)[number];
  rejectionCode: ModelProfileRejectionCode;
  observedDetail?: Record<string, unknown>;
  fallbackCandidates: SearchModel[];
  write: (line: string) => void;
}): void {
  const detail = input.observedDetail;
  const aspectRatios = Array.isArray(detail?.aspect_ratios)
    ? detail.aspect_ratios
        .slice(0, 16)
        .flatMap((value) => (safeDiagnosticText(value, 32) ? [safeDiagnosticText(value, 32)!] : []))
    : [];
  const fallbackCandidates = input.fallbackCandidates.slice(0, 5).map((candidate) => ({
    id: safeDiagnosticId(candidate.id) ?? null,
    name: safeDiagnosticText(candidate.name) ?? null,
    jobSetType: safeDiagnosticId(candidate.raw.job_set_type) ?? null,
    providerName: safeDiagnosticText(candidate.providerName) ?? null,
    outputType: safeDiagnosticText(candidate.outputType, 40) ?? null,
  }));
  input.write(
    stableJson({
      targetKey: input.target.key,
      canonicalJobType: input.target.canonicalJobSetType,
      rejectionCode: input.rejectionCode,
      responseIdentity: {
        id: diagnosticIdentityField(detail, "id"),
        modelId: diagnosticIdentityField(detail, "model_id"),
        jobSetType: diagnosticIdentityField(detail, "job_set_type"),
      },
      name: safeDiagnosticText(detail?.name ?? detail?.display_name) ?? null,
      providerName: safeDiagnosticText(detail?.provider_name) ?? null,
      outputType: safeDiagnosticText(detail?.output_type, 40) ?? null,
      parameters: diagnosticParameters(detail),
      aspectRatios,
      media: diagnosticMedia(detail),
      fallbackCandidates,
    }),
  );
}

export async function inspectHiggsfieldProvider(input: {
  listTools: (cursor?: string) => Promise<{ tools: unknown[]; nextCursor?: string }>;
  callTool: (name: "models_explore", args: Record<string, unknown>) => Promise<unknown>;
  logDiagnostic?: (line: string) => void;
  now?: number;
}): Promise<HiggsfieldCapabilityRecord> {
  const tools: DiscoveredTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  let enumerationComplete = false;
  while (pageCount < HIGGSFIELD_MCP_MAX_PAGES && tools.length < HIGGSFIELD_MCP_MAX_TOOLS) {
    const page = await input.listTools(cursor);
    pageCount += 1;
    const remaining = HIGGSFIELD_MCP_MAX_TOOLS - tools.length;
    tools.push(
      ...page.tools
        .flatMap((tool) => (normalizeTool(tool) ? [normalizeTool(tool)!] : []))
        .slice(0, remaining),
    );
    if (!page.nextCursor) {
      enumerationComplete = true;
      break;
    }
    if (tools.length >= HIGGSFIELD_MCP_MAX_TOOLS) break;
    if (cursors.has(page.nextCursor)) break;
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  const requiredToolsReady =
    enumerationComplete &&
    REQUIRED_TOOLS.every((name) => {
      const matching = tools.filter((tool) => tool.name === name);
      return matching.length === 1 && toolContractValid(matching[0]!);
    });
  const generateTool = tools.find((tool) => tool.name === "generate_image");
  const models: DiscoveredModelProfile[] = [];
  let listedModels: SearchModel[] | undefined;
  const listModels = async (): Promise<SearchModel[]> => {
    if (listedModels) return listedModels;
    listedModels = [];
    const cursors = new Set<string>();
    let nextCursor: string | undefined;
    for (
      let page = 0;
      page < HIGGSFIELD_MODEL_MAX_PAGES && listedModels.length < HIGGSFIELD_MODEL_MAX_ITEMS;
      page += 1
    ) {
      const response = await input.callTool("models_explore", {
        action: "list",
        type: "image",
        limit: 100,
        ...(nextCursor ? { after: nextCursor } : {}),
      });
      listedModels.push(
        ...modelItems(response).slice(0, HIGGSFIELD_MODEL_MAX_ITEMS - listedModels.length),
      );
      const pageResult = nextModelPage(response);
      if (!pageResult.valid) break;
      if (!pageResult.nextPageToken) break;
      if (cursors.has(pageResult.nextPageToken)) break;
      cursors.add(pageResult.nextPageToken);
      nextCursor = pageResult.nextPageToken;
    }
    return listedModels;
  };
  for (const target of MODEL_TARGETS) {
    const canonicalCandidate: SearchModel = {
      id: target.canonicalJobSetType,
      name: target.searchName,
      raw: {},
    };
    let canonicalDetail: Record<string, unknown> | undefined;
    let canonicalObservedDetail: Record<string, unknown> | undefined;
    try {
      const canonicalContent = structuredContent(
        await input.callTool("models_explore", {
          action: "get",
          model_id: target.canonicalJobSetType,
        }),
      );
      canonicalObservedDetail = observedDetailRecord(canonicalContent);
      canonicalDetail =
        detailRecordFromContent(canonicalContent, target.canonicalJobSetType) ?? undefined;
    } catch (error) {
      if (
        !(error instanceof HiggsfieldMcpError) ||
        (error.reason !== "provider_failure" && error.reason !== "invalid_response")
      ) {
        throw error;
      }
      canonicalDetail = undefined;
    }
    const profile = buildModelProfile({
      target,
      candidate: canonicalCandidate,
      detail: canonicalDetail,
      generateTool,
    });

    const fallbackCandidates: SearchModel[] = [];
    if (!profile.available) {
      // Alias discovery remains bounded diagnostics only. A failed canonical lookup must never
      // promote a similarly named provider model into the executable profile.
      try {
        const strictSearch = await input.callTool("models_explore", {
          action: "search",
          query: target.searchName,
          type: "image",
          input: "image",
          limit: 20,
        });
        let candidates = modelItems(strictSearch);
        fallbackCandidates.push(...candidates.slice(0, 5));
        let exact = candidates.filter((candidate) => searchModelMatches(target, candidate));
        if (exact.length === 0) {
          const relaxedSearch = await input.callTool("models_explore", {
            action: "search",
            query: target.searchName,
            type: "image",
            limit: 20,
          });
          candidates = modelItems(relaxedSearch);
          for (const candidate of candidates) {
            if (
              fallbackCandidates.length < 5 &&
              !fallbackCandidates.some((existing) => existing.id === candidate.id)
            ) {
              fallbackCandidates.push(candidate);
            }
          }
          exact = candidates.filter((candidate) => searchModelMatches(target, candidate));
        }
        if (exact.length === 0) {
          candidates = await listModels();
          for (const candidate of candidates) {
            if (
              fallbackCandidates.length < 5 &&
              !fallbackCandidates.some((existing) => existing.id === candidate.id)
            ) {
              fallbackCandidates.push(candidate);
            }
          }
        }
      } catch (error) {
        if (
          !(error instanceof HiggsfieldMcpError) ||
          (error.reason !== "provider_failure" && error.reason !== "invalid_response")
        ) {
          throw error;
        }
        // Canonical readiness already failed closed; provider diagnostics must not change it.
      }
    }
    const resolvedProfile: DiscoveredModelProfile = requiredToolsReady
      ? profile
      : { ...modelIdentity(target), available: false, reason: "tool_contract_invalid" };
    if (
      input.logDiagnostic &&
      target.key === "soul_2" &&
      resolvedProfile.reason === "profile_invalid"
    ) {
      logSoulProfileDiagnostic({
        target,
        rejectionCode: diagnoseSoulProfileRejection({
          target,
          observedDetail: canonicalObservedDetail,
          canonicalDetail,
          generateTool,
        }),
        observedDetail: canonicalObservedDetail,
        fallbackCandidates,
        write: input.logDiagnostic,
      });
    }
    models.push(resolvedProfile);
  }
  const now = input.now ?? Date.now();
  return {
    checkedAt: now,
    expiresAt: now + HIGGSFIELD_CAPABILITY_TTL_MS,
    toolCount: tools.length,
    pageCount,
    tools,
    models,
  };
}

async function runOfficialInspection(input: {
  mcpUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<HiggsfieldCapabilityRecord> {
  return withOfficialMcpClient({
    ...input,
    operation: async (client, signal) =>
      inspectHiggsfieldProvider({
        now: input.now,
        logDiagnostic: (line) => console.warn(line),
        listTools: async (cursor) => {
          const result = await client.listTools(cursor ? { cursor } : undefined, {
            signal,
            timeout: HIGGSFIELD_MCP_TIMEOUT_MS,
            maxTotalTimeout: HIGGSFIELD_MCP_TIMEOUT_MS,
          });
          return {
            tools: result.tools,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          };
        },
        callTool: async (name, args) =>
          client.callTool({ name, arguments: args }, undefined, {
            signal,
            timeout: HIGGSFIELD_MCP_TIMEOUT_MS,
            maxTotalTimeout: HIGGSFIELD_MCP_TIMEOUT_MS,
          }),
      }),
  });
}

export async function inspectHiggsfieldCapabilities(input: {
  sessionFingerprint: string;
  mcpUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
  runner?: typeof runOfficialInspection;
}): Promise<HiggsfieldCapabilityRecord> {
  const now = input.now ?? Date.now();
  const cached = capabilityCache.get(input.sessionFingerprint);
  if (cached && cached.expiresAt > now) return cached.value;
  const existing = inspectionFlights.get(input.sessionFingerprint);
  if (existing) return existing;
  const epoch = capabilityEpochs.get(input.sessionFingerprint) ?? 0;
  const promise = (input.runner ?? runOfficialInspection)(input)
    .then((value) => {
      if ((capabilityEpochs.get(input.sessionFingerprint) ?? 0) === epoch) {
        capabilityCache.set(input.sessionFingerprint, { value, expiresAt: value.expiresAt });
      }
      return value;
    })
    .finally(() => {
      if (inspectionFlights.get(input.sessionFingerprint) === promise) {
        inspectionFlights.delete(input.sessionFingerprint);
      }
    });
  inspectionFlights.set(input.sessionFingerprint, promise);
  return promise;
}

export function getHiggsfieldCapabilityRecord(
  sessionFingerprint: string,
  now = Date.now(),
): HiggsfieldCapabilityRecord | null {
  const cached = capabilityCache.get(sessionFingerprint);
  if (!cached || cached.expiresAt <= now) {
    capabilityCache.delete(sessionFingerprint);
    return null;
  }
  return cached.value;
}

export function getHiggsfieldCapabilitySummary(sessionFingerprint: string, now = Date.now()) {
  const record = getHiggsfieldCapabilityRecord(sessionFingerprint, now);
  if (!record) return { status: "not_checked" as const, models: [] };
  const ready = record.models.every((model) => model.available);
  return {
    status: ready ? ("ready" as const) : ("partial" as const),
    checkedAt: new Date(record.checkedAt).toISOString(),
    toolCount: record.toolCount,
    tools: record.tools
      .map((tool) => tool.name)
      .filter((name): name is HiggsfieldMcpToolName =>
        (REQUIRED_TOOLS as readonly string[]).includes(name),
      ),
    models: record.models.map((model) => ({
      key: model.key,
      name: model.displayName,
      ready: model.available,
      ...(model.available ? {} : { reason: model.reason }),
    })),
  };
}

export function clearHiggsfieldRuntime(sessionFingerprint: string): void {
  capabilityEpochs.set(sessionFingerprint, (capabilityEpochs.get(sessionFingerprint) ?? 0) + 1);
  capabilityCache.delete(sessionFingerprint);
  inspectionFlights.delete(sessionFingerprint);
}

export function requireDiscoveredModel(
  sessionFingerprint: string,
  key: DiscoveredModelProfile["key"],
): DiscoveredModelProfile & { available: true; modelId: string; inputContractHash: string } {
  const record = getHiggsfieldCapabilityRecord(sessionFingerprint);
  const profile = record?.models.find((model) => model.key === key);
  if (!profile?.available || !profile.modelId || !profile.inputContractHash) {
    throw new HiggsfieldMcpError("capability_required");
  }
  return profile as DiscoveredModelProfile & {
    available: true;
    modelId: string;
    inputContractHash: string;
  };
}

export async function callHiggsfieldMcpTool(input: {
  session: HiggsfieldOAuthSession;
  name: HiggsfieldMcpToolName;
  args: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  if (!(REQUIRED_TOOLS as readonly string[]).includes(input.name)) {
    throw new HiggsfieldMcpError("capability_required");
  }
  return withOfficialMcpClient({
    mcpUrl: input.session.resource,
    accessToken: input.session.accessToken,
    fetchImpl: input.fetchImpl,
    operation: async (client, signal) =>
      structuredContent(
        await client.callTool({ name: input.name, arguments: input.args }, undefined, {
          signal,
          timeout: HIGGSFIELD_MCP_TIMEOUT_MS,
          maxTotalTimeout: HIGGSFIELD_MCP_TIMEOUT_MS,
        }),
      ),
  });
}
