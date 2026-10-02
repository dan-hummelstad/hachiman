/**
 * URL → file mapping for the packaged renderer's `hachiman://app/…` scheme
 * (./renderer-protocol.ts). Free of `electron` imports so `node --test` can load it.
 */
import { realpath, stat } from "fs/promises";
import path from "path";

export const RENDERER_SCHEME = "hachiman";
export const RENDERER_HOST = "app";
export const RENDERER_INDEX_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;

/**
 * True for `hachiman://app/…`. A non-special scheme has an opaque `origin`
 * ("null"), so compare protocol and host instead.
 */
export function isRendererUrl(u: URL): boolean {
  return u.protocol === `${RENDERER_SCHEME}:` && u.host === RENDERER_HOST;
}

const isInside = (root: string, file: string): boolean =>
  file.startsWith(root + path.sep);

/**
 * The file under `rootDir` that `rawUrl` names, or null when the URL is not a
 * renderer URL or its path leaves `rootDir`. The renderer has no client-side
 * routes, so there is no index.html fallback: a missing file is a 404.
 */
export function resolveRendererPath(
  rootDir: string,
  rawUrl: string,
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isRendererUrl(url)) return null;

  let pathname: string;
  try {
    // Decode so `%2F..%2F` cannot hide a traversal from the containment check below.
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;

  const root = path.resolve(rootDir);
  const file = path.resolve(
    root,
    pathname.replace(/^[/\\]+/, "") || "index.html",
  );
  return isInside(root, file) ? file : null;
}

/**
 * The existing regular file `rawUrl` names, or null (the handler then answers
 * 404). Also compares real paths, so a symlink inside the renderer dir cannot
 * point outside it.
 */
export async function findRendererFile(
  rootDir: string,
  rawUrl: string,
): Promise<string | null> {
  const file = resolveRendererPath(rootDir, rawUrl);
  if (!file) return null;
  try {
    const [realRoot, realFile] = await Promise.all([
      realpath(rootDir),
      realpath(file),
    ]);
    if (!isInside(realRoot, realFile)) return null;
    return (await stat(realFile)).isFile() ? file : null;
  } catch {
    return null;
  }
}
