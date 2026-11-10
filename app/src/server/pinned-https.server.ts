import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export type PublicAddress = { address: string; family: 4 | 6 };

type LookupAll = (
  hostname: string,
  options: { all: true },
) => Promise<LookupAddress[]>;

function parseIpv6(value: string): Uint8Array | null {
  let address = value.toLowerCase().split("%")[0]!;
  const dotted = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split(".").map(Number);
    if (octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null;
    address =
      address.slice(0, -dotted.length) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    const parsed = Number.parseInt(word, 16);
    bytes[index * 2] = parsed >> 8;
    bytes[index * 2 + 1] = parsed & 0xff;
  });
  return bytes;
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/** Reject loopback, private, link-local, multicast, mapped, and NAT64-local targets. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const bytes = parseIpv6(address);
  if (!bytes) return true;
  if (
    bytes.every((item) => item === 0) ||
    (bytes.slice(0, 15).every((item) => item === 0) && bytes[15] === 1)
  ) {
    return true;
  }
  if (
    (bytes[0]! & 0xfe) === 0xfc ||
    bytes[0] === 0xff ||
    (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80)
  ) {
    return true;
  }
  const firstTenZero = bytes.slice(0, 10).every((item) => item === 0);
  const firstTwelveZero = bytes.slice(0, 12).every((item) => item === 0);
  if ((firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) || firstTwelveZero) {
    return isPrivateIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0 &&
    (bytes[5] === 0 || bytes[5] === 1)
  ) {
    return true;
  }
  return false;
}

export async function validatePublicHttpsTarget(
  value: string,
  lookupImpl: LookupAll = lookup as LookupAll,
): Promise<{ url: URL; addresses: PublicAddress[] }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("unsafe_https_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("unsafe_https_url");
  }
  let resolved: LookupAddress[];
  try {
    resolved = await lookupImpl(url.hostname, { all: true });
  } catch {
    throw new Error("https_dns_failed");
  }
  if (
    resolved.length === 0 ||
    resolved.some(
      (entry) =>
        (entry.family !== 4 && entry.family !== 6) || isPrivateAddress(entry.address),
    )
  ) {
    throw new Error("unsafe_https_address");
  }
  return {
    url,
    addresses: resolved.map((entry) => ({
      address: entry.address,
      family: entry.family as 4 | 6,
    })),
  };
}

function pinnedLookup(addresses: readonly PublicAddress[]): LookupFunction {
  const pinned = addresses.map((entry) => ({ ...entry }));
  const selected = pinned[0]!;
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, pinned.map((entry) => ({ ...entry })));
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

export type PinnedHttpsResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Uint8Array;
};

export async function requestPinnedHttps(input: {
  url: string;
  method: "GET" | "PUT";
  headers: Record<string, string>;
  body?: Uint8Array;
  maxResponseBytes: number;
  signal: AbortSignal;
}): Promise<PinnedHttpsResponse> {
  const target = await validatePublicHttpsTarget(input.url);
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: "https:",
      hostname: target.url.hostname,
      port: 443,
      path: `${target.url.pathname}${target.url.search}`,
      method: input.method,
      headers: {
        Host: target.url.hostname,
        ...input.headers,
        ...(input.body ? { "Content-Length": String(input.body.byteLength) } : {}),
      },
      servername: target.url.hostname,
      rejectUnauthorized: true,
      agent: false,
      signal: input.signal,
      lookup: pinnedLookup(target.addresses),
    };
    const request = httpsRequest(options, (response) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > input.maxResponseBytes) {
          response.destroy(new Error("https_response_limit"));
          return;
        }
        chunks.push(new Uint8Array(chunk));
      });
      response.on("error", reject);
      response.on("end", () => {
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes });
      });
    });
    request.on("error", reject);
    request.end(input.body);
  });
}
