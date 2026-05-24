import "tailwindcss";
import "@hachiman/hachiman/style.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  ThemeProvider,
  PlatformProvider,
  oracleService,
  type IMumbleServiceFactory,
  type IPlatformService,
  type MumbleConnectOptions,
} from "@hachiman/hachiman";
import {
  createCertificate as createCertificateCb,
  type CertificateCreationOptions,
  type CertificateCreationResult,
} from "pem";
import { MumbleService } from "../../../platforms/electron/MumbleService";
import { PlatformService } from "../../../platforms/electron/PlatformService";

// Electron renderer runs with nodeIntegration: true and contextIsolation: false,
// so the `electron` module is directly require-able here.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { ipcRenderer } = require("electron") as typeof import("electron");

// Subscribe to OAuth callback fired by the main process when it receives
// a `app.hachiman://oauth-callback` URL from the OS.
ipcRenderer.on(
  "hachiman:oauth-callback",
  async (_e, payload: { code: string; state: string }) => {
    try {
      await oracleService.completeSignIn(payload);
    } catch (err) {
      console.error("[oauth] callback failed", err);
    }
  }
);

// Expose a global the OracleSignInDialog can use to open the system browser
// via the main process. We use a global rather than threading through props
// because the dialog is built in the shared library that can't import electron.
;(window as unknown as { hachimanOpenExternal?: (url: string) => void }).hachimanOpenExternal =
  (url: string) => {
    void ipcRenderer.invoke("hachiman:open-external", url);
  };

function createCertificate(
  options: CertificateCreationOptions,
): Promise<CertificateCreationResult> {
  return new Promise((resolve, reject) => {
    createCertificateCb(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

const mumbleFactory: IMumbleServiceFactory = async (
  opts: MumbleConnectOptions,
) => {
  // Electron uses native TLS; generate a self-signed cert per connection.
  // TODO (punted): cache/persist the cert per server instead of regenerating each connect.
  const cert = await createCertificate({ days: 365, selfSigned: true });
  return new MumbleService(opts.serverUrl, opts.port, opts.username, cert, {
    oracleToken: opts.oracleToken,
  });
};

const platform: IPlatformService = new PlatformService();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlatformProvider value={{ mumble: mumbleFactory, platform }}>
      <ThemeProvider defaultTheme="system" storageKey="hachiman-ui-theme">
        <App />
      </ThemeProvider>
    </PlatformProvider>
  </StrictMode>,
);
