import "@hachiman/hachiman/style.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, ThemeProvider, PlatformProvider } from "@hachiman/hachiman";
import { platformService } from "./PlatformService";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlatformProvider value={platformService}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </PlatformProvider>
  </StrictMode>,
);
