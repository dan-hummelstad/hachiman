/**
 * Where the renderer comes from, chosen once at start-up.
 *
 * Packaged / preview: the built renderer, served from `hachiman://app/…`
 * instead of `file://`. A `file://` page sends `Origin: null`, which Takusen's
 * CORS rejects (and must reject: sandboxed iframes send it too). A privileged
 * standard scheme gives the page the real origin `hachiman://app`, which Takusen
 * allows by default (apps/takusen/src/lib/allowed-origins.ts). This scheme is NOT
 * an OS deep-link scheme; deep links stay `takusen://` and `app.hachiman://`
 * (./protocol-handler.ts).
 *
 * Dev: electron-vite's renderer dev server.
 */
import { net, protocol, session } from "electron";
import { pathToFileURL } from "url";
import {
  findRendererFile,
  isRendererUrl,
  RENDERER_INDEX_URL,
  RENDERER_SCHEME,
} from "./renderer-path";

export interface RendererSource {
  /** What the main window loads. */
  indexUrl: string;
  /** True for the app's own pages; the navigation guard blocks everything else. */
  isAppUrl(url: string): boolean;
  /** Starts serving (packaged) or decorating (dev) responses with `csp`. Call after `app.whenReady`. */
  serve(csp: string): void;
}

/** Must run before `app.whenReady`. */
export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function packagedRenderer(rootDir: string): RendererSource {
  return {
    indexUrl: RENDERER_INDEX_URL,
    isAppUrl: (url) => {
      const u = parse(url);
      return !!u && isRendererUrl(u);
    },
    serve: (csp) => {
      protocol.handle(RENDERER_SCHEME, async (request) => {
        const file = await findRendererFile(rootDir, request.url);
        if (!file) {
          return new Response("Not Found", {
            status: 404,
            headers: {
              "Content-Type": "text/plain",
              "Content-Security-Policy": csp,
            },
          });
        }
        // net.fetch on a file: URL sets Content-Type from the extension.
        const res = await net.fetch(pathToFileURL(file).toString());
        const headers = new Headers(res.headers);
        headers.set("Content-Security-Policy", csp);
        return new Response(res.body, { status: res.status, headers });
      });
    },
  };
}

export function devRenderer(devServerUrl: string): RendererSource {
  const origin = new URL(devServerUrl).origin;
  return {
    indexUrl: devServerUrl,
    isAppUrl: (url) => parse(url)?.origin === origin,
    serve: (csp) => {
      // The dev server sends no CSP; add the policy to its responses.
      session.defaultSession.webRequest.onHeadersReceived(
        { urls: [`${origin}/*`] },
        (details, callback) => {
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              "Content-Security-Policy": [csp],
            },
          });
        },
      );
    },
  };
}
