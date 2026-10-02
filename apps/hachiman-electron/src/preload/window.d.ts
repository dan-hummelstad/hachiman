// Renderer-side view of the preload bridge. Included by tsconfig.web.json only;
// the renderer has no other path to Electron.
import type { HachimanBridge } from "./index";

declare global {
  interface Window {
    hachiman: HachimanBridge;
  }
}
