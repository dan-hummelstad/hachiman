import "tailwindcss";
import "@hachiman/hachiman/style.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  ThemeProvider,
  PlatformProvider,
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
  return new MumbleService(opts.serverUrl, opts.port, opts.username, cert);
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
