/**
 * Settings that main needs before the renderer loads, in `<userData>/app-prefs.json`.
 * No electron import, so the unit test runs under plain node.
 */
import { readFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { join } from "path";

export interface AppPrefs {
  /** The close button hides the window to the tray. The app keeps running. */
  closeToTray: boolean;
}

export const DEFAULT_APP_PREFS: AppPrefs = { closeToTray: true };

export function parseAppPrefs(raw: unknown): AppPrefs {
  const o =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  return {
    closeToTray:
      typeof o.closeToTray === "boolean"
        ? o.closeToTray
        : DEFAULT_APP_PREFS.closeToTray,
  };
}

export interface AppPrefsStore {
  get(): AppPrefs;
  set(patch: Partial<AppPrefs>): Promise<void>;
}

/** Reads the file once (a missing or bad file gives the defaults). `set` writes it through a temp file. */
export function createAppPrefsStore(dir: string): AppPrefsStore {
  const file = join(dir, "app-prefs.json");
  let prefs: AppPrefs;
  try {
    prefs = parseAppPrefs(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    prefs = { ...DEFAULT_APP_PREFS };
  }
  return {
    get: () => prefs,
    set: async (patch) => {
      prefs = parseAppPrefs({ ...prefs, ...patch });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(prefs));
      await rename(tmp, file);
    },
  };
}
