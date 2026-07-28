import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rm, stat, unlink } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { TemporaryStorageConfig } from "./runtime-config.server";
import { getTemporaryStorageConfig } from "./runtime-config.server";

const MAINTENANCE_KEY = Symbol.for("hdex.temporary-storage.maintenance");
const globalMaintenance = globalThis as typeof globalThis & { [MAINTENANCE_KEY]?: NodeJS.Timeout };

function requireConfig(env: NodeJS.ProcessEnv = process.env): TemporaryStorageConfig {
  const config = getTemporaryStorageConfig(env);
  if (!config) throw new Error("temporary_storage_not_configured");
  return config;
}

function assertWithin(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error("unsafe_temporary_path");
  }
  return resolvedCandidate;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("unsafe_temporary_path");
  }
  return normalized;
}

export async function ensureTemporaryStorage(
  config: TemporaryStorageConfig = requireConfig(),
): Promise<void> {
  await mkdir(config.rootDirectory, { recursive: true, mode: 0o700 });
}

export async function withTemporaryFile<T>(input: {
  category: "uploads" | "downloads";
  sessionFingerprint: string;
  extension: string;
  bytes: Uint8Array;
  operation: (path: string) => Promise<T>;
  config?: TemporaryStorageConfig;
}): Promise<T> {
  const config = input.config ?? requireConfig();
  await ensureTemporaryStorage(config);
  const sessionDirectory = assertWithin(
    config.rootDirectory,
    join(config.rootDirectory, input.category, safeSegment(input.sessionFingerprint)),
  );
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const extension = safeSegment(input.extension).replace(/^\.+/, "") || "bin";
  const path = assertWithin(
    config.rootDirectory,
    join(sessionDirectory, `${Date.now()}-${randomBytes(16).toString("hex")}.${extension}`),
  );
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(input.bytes);
  } finally {
    await handle.close();
  }
  try {
    return await input.operation(path);
  } finally {
    await unlink(path).catch(() => undefined);
    await rm(sessionDirectory, { recursive: false }).catch(() => undefined);
  }
}

async function sweepDirectory(root: string, directory: string, expiresBefore: number): Promise<number> {
  assertWithin(root, directory);
  let removed = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = assertWithin(root, join(directory, entry.name));
    if (entry.isSymbolicLink()) {
      await unlink(path).catch(() => undefined);
      removed += 1;
      continue;
    }
    if (entry.isDirectory()) {
      removed += await sweepDirectory(root, path, expiresBefore);
      await rm(path, { recursive: false }).catch(() => undefined);
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await stat(path).catch(() => null);
    if (metadata && metadata.mtimeMs <= expiresBefore) {
      await unlink(path).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

export async function sweepExpiredTemporaryStorage(input: {
  config?: TemporaryStorageConfig;
  now?: number;
} = {}): Promise<number> {
  const config = input.config ?? requireConfig();
  await ensureTemporaryStorage(config);
  const root = resolve(config.rootDirectory);
  let removed = 0;
  for (const category of ["uploads", "downloads", "jobs"] as const) {
    const directory = assertWithin(root, join(root, category));
    removed += await sweepDirectory(root, directory, (input.now ?? Date.now()) - config.ttlMs)
      .catch(() => 0);
  }
  return removed;
}

export function startTemporaryStorageMaintenance(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (globalMaintenance[MAINTENANCE_KEY]) return;
  const config = getTemporaryStorageConfig(env);
  if (!config) return;
  void sweepExpiredTemporaryStorage({ config }).catch(() => undefined);
  const intervalMs = Math.min(Math.max(Math.floor(config.ttlMs / 2), 60_000), 15 * 60_000);
  const timer = setInterval(() => {
    void sweepExpiredTemporaryStorage({ config }).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  globalMaintenance[MAINTENANCE_KEY] = timer;
}

export function temporaryStorageFileName(path: string): string {
  return basename(path);
}
