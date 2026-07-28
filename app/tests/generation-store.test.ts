import { afterAll, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  claimGenerationAttempt,
  clearGenerationStore,
  GENERATION_STATE_SCHEMA_VERSION,
  generationRequestHash,
  listGenerationJobs,
} from "../src/server/generation-attempt-store.server";
import { sweepExpiredTemporaryStorage } from "../src/server/temporary-storage.server";

const NOW = Date.UTC(2026, 6, 27, 5, 0, 0);
const TEMP_DIR = await mkdtemp(join(tmpdir(), "hdex-generation-store-"));
const ENV = {
  HDEX_GENERATION_ENABLED: "true",
  HDEX_TEMP_DIR: TEMP_DIR,
  HDEX_TEMP_TTL_SECONDS: "3600",
} as NodeJS.ProcessEnv;

afterAll(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
});

function stateFile(fingerprint: string): string {
  return join(TEMP_DIR, "hdex-influencer-frame", "jobs", `${fingerprint}.json`);
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectMissing(file: string): Promise<void> {
  await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("fail-closed generation attempt storage", () => {
  test("allows only one atomic request claim across separate processes", async () => {
    const fingerprint = "multiprocess-claim-session";
    const requestId = "request-multiprocess-0001";
    const requestHash = generationRequestHash({ prompt: "same paid request" });
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "../src/server/generation-attempt-store.server.ts"),
    ).href;
    const worker = `
      const store = await import(${JSON.stringify(moduleUrl)});
      const result = await store.claimGenerationAttempt(${JSON.stringify({
        sessionFingerprint: fingerprint,
        requestId,
        requestHash,
        env: ENV,
        now: NOW,
      })});
      console.log(JSON.stringify({ claimed: result.claimed, conflict: result.conflict }));
    `;
    const processes = [
      Bun.spawn([process.execPath, "-e", worker], { stdout: "pipe", stderr: "pipe" }),
      Bun.spawn([process.execPath, "-e", worker], { stdout: "pipe", stderr: "pipe" }),
    ];
    const results = await Promise.all(
      processes.map(async (process) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return JSON.parse(stdout.trim()) as { claimed: boolean; conflict: boolean };
      }),
    );
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toHaveLength(1);
    expect(results.every((result) => !result.conflict)).toBe(true);
  });

  test("keeps an active claim lock outside TTL sweeping and blocks a second process", async () => {
    const fingerprint = "sweep-active-lock-session";
    const requestId = "request-sweep-lock-0001";
    const requestHash = generationRequestHash({ prompt: "same paid request during sweep" });
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "../src/server/generation-attempt-store.server.ts"),
    ).href;
    const enteredA = join(TEMP_DIR, "sweep-lock-a-entered");
    const enteredB = join(TEMP_DIR, "sweep-lock-b-entered");
    const releaseA = join(TEMP_DIR, "sweep-lock-a-release");
    const input = {
      sessionFingerprint: fingerprint,
      requestId,
      requestHash,
      env: ENV,
      now: NOW,
    };
    const workerA = `
      const { access, writeFile } = await import("node:fs/promises");
      const store = await import(${JSON.stringify(moduleUrl)});
      const result = await store.claimGenerationAttempt({
        ...${JSON.stringify(input)},
        testHooks: { beforePersist: async () => {
          await writeFile(${JSON.stringify(enteredA)}, "entered");
          while (true) {
            try { await access(${JSON.stringify(releaseA)}); break; }
            catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
          }
        } },
      });
      console.log(JSON.stringify({ claimed: result.claimed, conflict: result.conflict }));
    `;
    const workerB = `
      const { writeFile } = await import("node:fs/promises");
      const store = await import(${JSON.stringify(moduleUrl)});
      const result = await store.claimGenerationAttempt({
        ...${JSON.stringify(input)},
        testHooks: { afterRead: async () => {
          await writeFile(${JSON.stringify(enteredB)}, "entered");
        } },
      });
      console.log(JSON.stringify({ claimed: result.claimed, conflict: result.conflict }));
    `;
    const processA = Bun.spawn([process.execPath, "-e", workerA], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForFile(enteredA);
    const activeLock = join(
      TEMP_DIR,
      "hdex-influencer-frame",
      "generation-locks",
      `${fingerprint}.claim.lock`,
    );
    await access(activeLock);
    await sweepExpiredTemporaryStorage({
      config: {
        baseDirectory: TEMP_DIR,
        rootDirectory: join(TEMP_DIR, "hdex-influencer-frame"),
        ttlMs: 60_000,
      },
      now: Date.now() + 3_600_000,
    });
    await access(activeLock);

    const processB = Bun.spawn([process.execPath, "-e", workerB], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitedBeforeRelease = await Promise.race([
      processB.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(exitedBeforeRelease).toBe(false);
    await expect(access(enteredB)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(releaseA, "release");
    const readResult = async (process: ReturnType<typeof Bun.spawn>) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout.trim()) as { claimed: boolean; conflict: boolean };
    };
    const results = await Promise.all([readResult(processA), readResult(processB)]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toHaveLength(1);
    expect(results.every((result) => !result.conflict)).toBe(true);
  });

  test("disconnect invalidates an in-flight first load without restoring the state file", async () => {
    const fingerprint = "disconnect-load-session";
    const file = stateFile(fingerprint);
    const requestHash = generationRequestHash({ prompt: "already accepted" });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
        sessionFingerprint: fingerprint,
        revocationToken: "initial",
        attempts: [
          {
            requestId: "request-already-accepted",
            sessionFingerprint: fingerprint,
            requestHash,
            status: "accepted",
            providerJobIds: [],
            createdAt: NOW,
            expiresAt: NOW + 3_600_000,
          },
        ],
        jobs: [],
        media: [],
      }),
    );
    const entered = deferred();
    const release = deferred();
    const load = claimGenerationAttempt({
      requestId: "request-after-load-0001",
      sessionFingerprint: fingerprint,
      requestHash: generationRequestHash({ prompt: "new request" }),
      env: ENV,
      now: NOW,
      testHooks: {
        afterRead: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    await entered.promise;
    const clear = clearGenerationStore(fingerprint, ENV);
    release.resolve();
    await expect(load).rejects.toMatchObject({ code: "generation_store_invalidated" });
    await clear;
    await expectMissing(file);
    expect((await listGenerationJobs({ sessionFingerprint: fingerprint, size: 10, env: ENV })).length)
      .toBe(0);
  });

  test("disconnect invalidates an in-flight write without recreating the state file", async () => {
    const fingerprint = "disconnect-write-session";
    const file = stateFile(fingerprint);
    const entered = deferred();
    const release = deferred();
    const write = claimGenerationAttempt({
      requestId: "request-before-write-0001",
      sessionFingerprint: fingerprint,
      requestHash: generationRequestHash({ prompt: "must be revoked" }),
      env: ENV,
      now: NOW,
      testHooks: {
        beforePersist: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    await entered.promise;
    const clear = clearGenerationStore(fingerprint, ENV);
    release.resolve();
    await expect(write).rejects.toMatchObject({ code: "generation_store_invalidated" });
    await clear;
    await expectMissing(file);
    expect((await listGenerationJobs({ sessionFingerprint: fingerprint, size: 10, env: ENV })).length)
      .toBe(0);
  });
});
