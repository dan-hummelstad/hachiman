// First import: defines window.__hachimanNative before anything else runs.
import "./platforms/ios/native-events.ts";
import "@hachiman/hachiman/style.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, ThemeProvider, PlatformProvider } from "@hachiman/hachiman";
import { call } from "./platforms/ios/bridge.ts";
import { platformService } from "./platforms/ios/PlatformService.ts";

const launchQuery = new URLSearchParams(location.search);
const root = document.getElementById("root")!;

/** Native holds its events until this op; the emitter buffers them per type until the UI subscribes. */
function signalReady(): void {
  call("ready", {}).catch((e: unknown) => {
    // `vite` dev in a plain browser has no native side.
    if ((e as { code?: unknown }).code !== "Unsupported")
      console.error("[platform] ready failed", e);
  });
}

// Dev-only fixture mode (`?preview`, `?preview=signedout`, `&theme=light`, `&display=compact`).
// `import.meta.env.DEV` is false in production builds, so this branch and its chunk drop out.
async function boot(): Promise<void> {
  const q = launchQuery;
  if (import.meta.env.DEV && q.has("preview")) {
    const { startPreview, previewOptionsFromQuery } =
      await import("@hachiman/hachiman/dev/preview/index");
    startPreview(previewOptionsFromQuery(q));
  }
}

void boot().then(() => {
  createRoot(root).render(
    <StrictMode>
      <PlatformProvider value={platformService}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </PlatformProvider>
    </StrictMode>,
  );
  signalReady();
});
