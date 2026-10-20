/**
 * The `hachiman:fetch-link` guard: no network. The lookup gets a fake resolver, and
 * fetchLinkResource a fake `get` that serves canned responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import {
  fetchLinkResource,
  MAX_REDIRECTS,
  publicLookup,
  type Get,
} from "./link-fetch.ts";

function lookupResult(addresses: string[], all: boolean): Promise<unknown[]> {
  const lookup = publicLookup((_host, cb) =>
    cb(
      null,
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    ),
  );
  return new Promise((resolve) =>
    (
      lookup as unknown as (
        h: string,
        o: object,
        cb: (...a: unknown[]) => void,
      ) => void
    )("x.example", { all }, (...args) => resolve(args)),
  );
}

test("the lookup refuses a host with any non-public address", async () => {
  for (const bad of [
    ["10.0.0.5"],
    ["93.184.216.34", "127.0.0.1"],
    ["::1"],
    ["169.254.169.254"],
    [],
  ]) {
    const [err] = await lookupResult(bad, true);
    assert.ok(err instanceof Error, `refused ${bad.join(",")}`);
  }
  const [err, address, family] = await lookupResult(["93.184.216.34"], false);
  assert.equal(err, null);
  assert.equal(address, "93.184.216.34");
  assert.equal(family, 4);
  const [errAll, list] = await lookupResult(["93.184.216.34"], true);
  assert.equal(errAll, null);
  assert.deepEqual(list, [{ address: "93.184.216.34", family: 4 }]);
});

function response(
  status: number,
  headers: Record<string, string>,
  body = "",
): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    statusCode: status,
    headers,
  }) as unknown as IncomingMessage;
}

/** A `get` that serves `routes[url]` and records each URL it was asked for. */
function fakeGet(
  routes: Record<string, () => IncomingMessage>,
): Get & { seen: string[] } {
  const seen: string[] = [];
  const get: Get = async (url) => {
    seen.push(url.href);
    const r = routes[url.href];
    if (!r) throw new Error(`no route ${url.href}`);
    return r();
  };
  return Object.assign(get, { seen });
}

test("refuses bad arguments before any request", async () => {
  const get = fakeGet({});
  for (const [url, max] of [
    ["http://a.example/", 100],
    ["https://user:pw@a.example/", 100],
    ["https://127.0.0.1/", 100],
    ["https://[::1]/", 100],
    ["file:///etc/passwd", 100],
    ["not a url", 100],
    [42, 100],
    ["https://a.example/", 0],
    ["https://a.example/", "100"],
  ] as const) {
    assert.equal(await fetchLinkResource(url, max, get), null, String(url));
  }
  assert.deepEqual(get.seen, []);
});

test("returns the body, type and final URL; follows https redirects only", async () => {
  const get = fakeGet({
    "https://a.example/": () => response(301, { location: "/b" }),
    "https://a.example/b": () =>
      response(
        200,
        { "content-type": "text/html; charset=utf-8" },
        "<title>B</title>",
      ),
    "https://a.example/down": () =>
      response(302, { location: "http://a.example/b" }),
  });
  const r = await fetchLinkResource("https://a.example/", 1000, get);
  assert.ok(r);
  assert.equal(r.url, "https://a.example/b");
  assert.equal(r.contentType, "text/html");
  assert.equal(new TextDecoder().decode(r.body), "<title>B</title>");
  assert.equal(
    await fetchLinkResource("https://a.example/down", 1000, get),
    null,
  );
});

test("stops at the redirect limit, a non-200 status and the byte cap", async () => {
  const loop = fakeGet(
    Object.fromEntries(
      Array.from({ length: MAX_REDIRECTS + 2 }, (_, i) => [
        `https://a.example/${i}`,
        () => response(302, { location: `/${i + 1}` }),
      ]),
    ),
  );
  assert.equal(
    await fetchLinkResource("https://a.example/0", 1000, loop),
    null,
  );
  assert.equal(loop.seen.length, MAX_REDIRECTS + 1);

  const get = fakeGet({
    "https://a.example/404": () => response(404, {}),
    "https://a.example/big": () =>
      response(200, { "content-length": "5000" }, "x"),
    "https://a.example/long": () => response(200, {}, "x".repeat(2000)),
  });
  for (const path of ["404", "big", "long"]) {
    assert.equal(
      await fetchLinkResource(`https://a.example/${path}`, 1000, get),
      null,
      path,
    );
  }
});
