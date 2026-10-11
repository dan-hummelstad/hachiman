import "@hachiman/hachiman/style.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, ThemeProvider, PlatformProvider } from "@hachiman/hachiman";
import {
  consumeLaunchUrl,
  platformService,
} from "./platforms/browser/PlatformService";

// Read before consumeLaunchUrl(), which rewrites the URL (e.g. `/invite/<code>?preview` → `/`).
const launchQuery = new URLSearchParams(location.search);
consumeLaunchUrl();

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

void boot().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <PlatformProvider value={platformService}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </PlatformProvider>
    </StrictMode>,
  ),
);
