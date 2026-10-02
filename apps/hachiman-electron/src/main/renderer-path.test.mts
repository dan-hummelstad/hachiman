/**
 * Unit tests for the `hachiman://app/…` → file resolver.
 * Run via the package `test` script (node's test runner + native TS type-stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  findRendererFile,
  isRendererUrl,
  RENDERER_INDEX_URL,
  resolveRendererPath,
} from "./renderer-path.ts";

const ROOT = path.resolve("/opt/hachiman/renderer");

test("index URL and bare origin map to index.html", () => {
  assert.equal(
    resolveRendererPath(ROOT, RENDERER_INDEX_URL),
    path.join(ROOT, "index.html"),
  );
  assert.equal(
    resolveRendererPath(ROOT, "hachiman://app/"),
    path.join(ROOT, "index.html"),
  );
});

test("asset paths resolve inside the renderer dir; query and hash are ignored", () => {
  assert.equal(
    resolveRendererPath(ROOT, "hachiman://app/assets/index-abc.js?v=1#x"),
    path.join(ROOT, "assets", "index-abc.js"),
  );
  assert.equal(
    resolveRendererPath(ROOT, "hachiman://app/assets/a%20b.woff2"),
    path.join(ROOT, "assets", "a b.woff2"),
  );
});

test("path traversal is blocked", () => {
  for (const url of [
    "hachiman://app/../../etc/passwd",
    "hachiman://app/%2e%2e/%2e%2e/etc/passwd",
    "hachiman://app/assets/..%2F..%2F..%2Fetc%2Fpasswd",
    "hachiman://app/..%5C..%5Cwindows%5Cwin.ini",
    "hachiman://app/%2F..%2Frenderer-evil/x.js",
    "hachiman://app/a%00.js",
    "hachiman://app/%E0%A4%A",
  ]) {
    const got = resolveRendererPath(ROOT, url);
    assert.ok(
      got === null || got.startsWith(ROOT + path.sep),
      `${url} resolved outside the root: ${got}`,
    );
  }
  assert.equal(
    resolveRendererPath(
      ROOT,
      "hachiman://app/assets/..%2F..%2F..%2Fetc%2Fpasswd",
    ),
    null,
  );
  assert.equal(resolveRendererPath(ROOT, "hachiman://app/a%00.js"), null);
  assert.equal(resolveRendererPath(ROOT, "hachiman://app/%E0%A4%A"), null);
});

test("sibling directory with the root as a name prefix is outside the root", () => {
  assert.equal(
    resolveRendererPath(ROOT, "hachiman://app/..%2Frenderer-evil%2Fx.js"),
    null,
  );
});

test("other schemes and hosts are refused (the handler answers 404)", () => {
  assert.equal(resolveRendererPath(ROOT, "hachiman://evil/index.html"), null);
  assert.equal(
    resolveRendererPath(ROOT, "file:///opt/hachiman/renderer/index.html"),
    null,
  );
  assert.equal(resolveRendererPath(ROOT, "https://app/index.html"), null);
  assert.equal(resolveRendererPath(ROOT, "not a url"), null);
});

test("on disk: index served, unknown paths, directories and escapes are 404 (null)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hachiman-renderer-"));
  try {
    const root = path.join(tmp, "renderer");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html>");
    await writeFile(path.join(tmp, "secret.txt"), "outside");

    assert.equal(
      await findRendererFile(root, RENDERER_INDEX_URL),
      path.join(root, "index.html"),
    );
    // No client-side routes, so no index.html fallback.
    assert.equal(await findRendererFile(root, "hachiman://app/settings"), null);
    assert.equal(await findRendererFile(root, "hachiman://app/assets"), null);
    assert.equal(
      await findRendererFile(root, "hachiman://app/..%2Fsecret.txt"),
      null,
    );
    assert.equal(
      await findRendererFile(root, "hachiman://app/../secret.txt"),
      null,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("isRendererUrl matches only hachiman://app", () => {
  assert.equal(isRendererUrl(new URL("hachiman://app/x.js")), true);
  assert.equal(isRendererUrl(new URL("hachiman://evil/x.js")), false);
  assert.equal(isRendererUrl(new URL("https://app/x.js")), false);
  assert.equal(isRendererUrl(new URL("file:///app/x.js")), false);
});

test("on disk: a symlink inside the root that points outside is 404 (null)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hachiman-renderer-"));
  try {
    const root = path.join(tmp, "renderer");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(tmp, "secret.txt"), "outside");
    await symlink(path.join(tmp, "secret.txt"), path.join(root, "leak.txt"));
    assert.equal(await findRendererFile(root, "hachiman://app/leak.txt"), null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
