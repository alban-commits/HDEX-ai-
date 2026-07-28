import { Buffer } from "node:buffer";
import { isAbsolute, resolve } from "node:path";

export type HiggsfieldOAuthConfig = {
  publicOrigin: string;
  callbackUrl: string;
  mcpUrl: string;
  cookieSecret: Uint8Array;
};

export type TemporaryStorageConfig = {
  baseDirectory: string;
  rootDirectory: string;
  ttlMs: number;
};

export const DEFAULT_HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
export const TEMP_STORAGE_DIRECTORY_NAME = "hdex-influencer-frame";
const MIN_TEMP_TTL_SECONDS = 60;
const MAX_TEMP_TTL_SECONDS = 7 * 24 * 60 * 60;

function parsePublicOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseMcpUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value?.trim() || DEFAULT_HIGGSFIELD_MCP_URL);
    const trustedHost =
      url.hostname === "higgsfield.ai" || url.hostname.endsWith(".higgsfield.ai");
    if (
      url.protocol !== "https:" ||
      !trustedHost ||
      url.username ||
      url.password ||
      url.pathname !== "/mcp" ||
      url.search ||
      url.hash
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseCookieSecret(value: string | undefined): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.trim())) return null;
  const decoded = Buffer.from(value.trim(), "base64url");
  return decoded.byteLength === 32 ? new Uint8Array(decoded) : null;
}

function isAbsoluteServerPath(value: string): boolean {
  return (
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

function parseTemporaryStorage(env: NodeJS.ProcessEnv): TemporaryStorageConfig | null {
  const rawDirectory = env.HDEX_TEMP_DIR?.trim();
  const rawTtl = env.HDEX_TEMP_TTL_SECONDS?.trim();
  if (!rawDirectory || !isAbsoluteServerPath(rawDirectory) || !rawTtl || !/^\d+$/.test(rawTtl)) {
    return null;
  }
  const ttlSeconds = Number(rawTtl);
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < MIN_TEMP_TTL_SECONDS ||
    ttlSeconds > MAX_TEMP_TTL_SECONDS
  ) return null;
  // Keep Windows drive/UNC paths intact while validating configuration on a
  // non-Windows CI host. Node's path.resolve would otherwise prepend the macOS
  // checkout path to a valid Windows deployment path.
  const baseDirectory = /^[A-Za-z]:[\\/]/.test(rawDirectory) || rawDirectory.startsWith("\\\\")
    ? rawDirectory
    : resolve(rawDirectory);
  return {
    baseDirectory,
    rootDirectory: /^[A-Za-z]:[\\/]/.test(baseDirectory) || baseDirectory.startsWith("\\\\")
      ? `${baseDirectory.replace(/[\\/]+$/, "")}\\${TEMP_STORAGE_DIRECTORY_NAME}`
      : resolve(baseDirectory, TEMP_STORAGE_DIRECTORY_NAME),
    ttlMs: ttlSeconds * 1_000,
  };
}

function nodeEnvironmentConfigured(value: string | undefined): boolean {
  return value === "production" || value === "development" || value === "test";
}

export function isLoopbackHost(value: string | undefined): boolean {
  const host = value?.trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function isGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HDEX_GENERATION_ENABLED?.trim().toLowerCase() === "true";
}

export function getTemporaryStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): TemporaryStorageConfig | null {
  return parseTemporaryStorage(env);
}

export function getHiggsfieldOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): HiggsfieldOAuthConfig | null {
  const publicOrigin = parsePublicOrigin(env.HDEX_PUBLIC_ORIGIN);
  const mcpUrl = parseMcpUrl(env.HDEX_HIGGSFIELD_MCP_URL);
  const cookieSecret = parseCookieSecret(env.HDEX_HIGGSFIELD_OAUTH_COOKIE_SECRET);
  if (!publicOrigin || !mcpUrl || !cookieSecret) return null;
  return {
    publicOrigin,
    callbackUrl: new URL("/api/higgsfield/oauth/callback", publicOrigin).toString(),
    mcpUrl,
    cookieSecret,
  };
}

export function getRuntimeReadiness(env: NodeJS.ProcessEnv = process.env) {
  const oauthConfigured = getHiggsfieldOAuthConfig(env) !== null;
  const openAiConfigured = Boolean(env.OPENAI_API_KEY?.trim());
  const temporaryStorageConfigured = parseTemporaryStorage(env) !== null;
  const nodeRuntime = process.release.name === "node";
  const nodeEnvironment = nodeEnvironmentConfigured(env.NODE_ENV);
  const loopbackBind = isLoopbackHost(env.HOST);
  const generationSwitch =
    env.HDEX_GENERATION_ENABLED === undefined ||
    /^(true|false)$/.test(env.HDEX_GENERATION_ENABLED.trim().toLowerCase());
  return {
    ready:
      oauthConfigured &&
      openAiConfigured &&
      temporaryStorageConfigured &&
      nodeRuntime &&
      nodeEnvironment &&
      loopbackBind &&
      generationSwitch,
    checks: {
      nodeRuntime,
      nodeEnvironment,
      loopbackBind,
      publicOrigin: parsePublicOrigin(env.HDEX_PUBLIC_ORIGIN) !== null,
      oauthCookieSecret: parseCookieSecret(env.HDEX_HIGGSFIELD_OAUTH_COOKIE_SECRET) !== null,
      higgsfieldMcp: parseMcpUrl(env.HDEX_HIGGSFIELD_MCP_URL) !== null,
      openAi: openAiConfigured,
      temporaryStorage: temporaryStorageConfigured,
      generationSwitch,
      generationEnabled: isGenerationEnabled(env),
    },
  };
}
