import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { LookupAddress } from "node:dns";
import type { IncomingMessage, RequestOptions } from "node:http";
import { fetchRemoteImage } from "../remote-image.js";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ get: mocks.get }));
vi.mock("node:https", () => ({ get: mocks.get }));

type Reply = { status: number; headers: Record<string, string>; bytes?: string };
let replies: Reply[];
let connections: { url: string; addresses: LookupAddress[] }[];
let responses: IncomingMessage[];
const options = () => ({ signal: new AbortController().signal });

beforeEach(() => {
  vi.resetAllMocks(); replies = []; connections = []; responses = [];
  mocks.lookup.mockImplementation((_host, _options, done) => done(null, [{ address: "93.184.216.34", family: 4 }]));
  mocks.get.mockImplementation((url: URL, opts: RequestOptions, done: (response: IncomingMessage) => void) => {
    const req = new EventEmitter();
    queueMicrotask(() => {
      // Emulate the socket's actual lookup seam; no network connection exists.
      opts.lookup!(url.hostname, { all: true }, (error, addresses) => {
        if (error) { req.emit("error", error); return; }
        expect(opts.agent).toBe(false);
        connections.push({ url: url.href, addresses: addresses as LookupAddress[] });
        const reply = replies.shift() ?? { status: 200, headers: { "content-type": "image/png" }, bytes: "tiny image" };
        const response = Readable.from([Buffer.from(reply.bytes ?? "")]) as IncomingMessage;
        response.statusCode = reply.status; response.headers = reply.headers;
        responses.push(response); done(response);
      });
    });
    return req;
  });
});

describe("public remote image transport", () => {
  it("keeps public URLs and relative redirects working with checked socket addresses", async () => {
    replies.push({ status: 302, headers: { location: "/final.png" } });
    const response = await fetchRemoteImage("https://images.example/start.png", options());
    expect(await response.text()).toBe("tiny image");
    expect(connections.map(c => c.url)).toEqual(["https://images.example/start.png", "https://images.example/final.png"]);
    expect(connections.every(c => c.addresses[0].address === "93.184.216.34")).toBe(true);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(responses[0].destroyed).toBe(true);
  });

  it.each([
    "http://127.0.0.1/image", "http://2130706433/image", "http://0x7f000001/image",
    "http://169.254.169.254/image", "http://10.1.2.3/image", "http://192.168.1.1/image",
    "http://172.16.0.1/image", "http://100.64.0.1/image", "http://0.0.0.0/image",
    "http://[::1]/image", "http://[::ffff:127.0.0.1]/image", "http://[fc00::1]/image",
    "http://[fe80::1]/image", "http://[2002:7f00:1::]/image", "file:///etc/hosts",
  ])("rejects a non-public or unsupported URL before opening a request: %s", async url => {
    await expect(fetchRemoteImage(url, options())).rejects.toMatchObject({ type: "INVALID_IMAGE_PATH" });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("blocks redirects into private literal addresses before a second request", async () => {
    replies.push({ status: 302, headers: { location: "http://127.0.0.1/admin/secret" } });
    await expect(fetchRemoteImage("https://images.example/photo.png", options())).rejects.toMatchObject({ type: "INVALID_IMAGE_PATH" });
    expect(connections).toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(responses[0].destroyed).toBe(true);
  });

  it("rejects mixed/private DNS results and rechecks DNS on a redirect to the same host", async () => {
    mocks.lookup.mockImplementationOnce((_host, _options, done) => done(null, [{ address: "93.184.216.34", family: 4 }]))
      .mockImplementation((_host, _options, done) => done(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]));
    replies.push({ status: 302, headers: { location: "/rebound.png" } });
    await expect(fetchRemoteImage("https://images.example/photo.png", options())).rejects.toMatchObject({ type: "INVALID_IMAGE_PATH" });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(connections).toHaveLength(1);
    expect(connections[0].addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("accepts public IPv6 DNS results and passes the cancellation signal to the socket", async () => {
    mocks.lookup.mockImplementation((_host, _options, done) => done(null, [{ address: "2606:4700:4700::1111", family: 6 }]));
    const init = options(); const response = await fetchRemoteImage("https://images.example/a.png", init);
    expect(await response.text()).toBe("tiny image");
    expect(connections[0].addresses[0].family).toBe(6);
    expect(mocks.get.mock.calls[0][1].signal).toBe(init.signal);
    const controller = new AbortController(); controller.abort();
    await expect(fetchRemoteImage("https://images.example/a.png", { signal: controller.signal })).rejects.toBeDefined();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("bounds redirect loops and closes each response", async () => {
    replies = Array.from({ length: 7 }, () => ({ status: 302, headers: { location: "/again.png" } }));
    await expect(fetchRemoteImage("https://images.example/a.png", options())).rejects.toThrow("five redirects");
    expect(connections).toHaveLength(6);
    expect(responses.every(r => r.destroyed)).toBe(true);
  });
});
