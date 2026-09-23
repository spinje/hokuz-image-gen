/** Public-network image downloads, without automatic redirects or DNS re-resolution. */
import { lookup } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { ErrorType, McpError } from "../types.js";

// Conservative policy based on IANA's special-purpose address registries.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const blocked4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked6.addSubnet(address, prefix, "ipv6");

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked4.check(address, "ipv4");
  // Restrict to native global unicast, excluding translation/tunnelling forms
  // such as IPv4-mapped IPv6 and NAT64 that can encode a private destination.
  return isIP(address) === 6 && global6.check(address, "ipv6") && !blocked6.check(address, "ipv6");
}

function invalidRemote(reason: string): McpError {
  return new McpError(ErrorType.INVALID_IMAGE_PATH, `Error: ${reason} Use a public image URL or download the image and pass a local file.`);
}

function checkedUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw invalidRemote("Invalid remote image URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidRemote("Image URLs must use HTTP or HTTPS.");
  if (url.username || url.password) throw invalidRemote("Image URLs must not contain username/password credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host)) throw invalidRemote("Remote image destinations must be public internet addresses.");
  return url;
}

// This callback supplies the checked addresses directly to the socket. A
// separate preflight lookup followed by ordinary fetch would allow rebinding.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: options.family, verbatim: true }, (error, addresses) => {
    if (error) { callback(error, "", 4); return; }
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      callback(invalidRemote("Remote image DNS must resolve only to public internet addresses."), "", 4);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

function request(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const get = url.protocol === "https:" ? https.get : http.get;
    get(url, {
      signal,
      lookup: publicLookup,
      // No pooled connection bypasses the checked lookup. The original URL
      // retains the correct HTTP Host and TLS server name/certificate checks.
      agent: false,
      headers: { accept: "image/*", "accept-encoding": "identity" },
    }, resolve).on("error", reject);
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export async function fetchRemoteImage(value: string, { signal }: { signal: AbortSignal }): Promise<Response> {
  let url = checkedUrl(value);
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    const incoming = await request(url, signal);
    const status = incoming.statusCode ?? 500;
    if (REDIRECTS.has(status)) {
      const location = incoming.headers.location;
      incoming.destroy();
      if (hop >= MAX_REDIRECTS) throw invalidRemote("Remote image exceeded five redirects.");
      if (!location) throw invalidRemote("Remote image redirect has no Location header.");
      url = checkedUrl(location, url);
      continue;
    }
    const headers = new Headers();
    for (const [key, val] of Object.entries(incoming.headers)) {
      if (val !== undefined) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
    }
    if (status < 200 || status >= 300 || status === 204 || status === 205) {
      incoming.destroy();
      return new Response(null, { status, headers });
    }
    const encoding = headers.get("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      incoming.destroy();
      throw invalidRemote("Remote image server must honor Accept-Encoding: identity.");
    }
    return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers });
  }
}
