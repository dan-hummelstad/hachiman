import type { GlobalShortcutInfo } from "../shared/ipc.ts";

/**
 * OS-wide shortcuts for the `hachiman:set-global-shortcuts` IPC (§11
 * `setGlobalShortcuts`). The renderer names an action and an accelerator; main
 * registers it with Electron `globalShortcut` and sends the action back when
 * it fires. The payload is untrusted, so only a short list of keys and
 * modifiers passes. A key needs no modifier: the user picks the combo, and a
 * key without one (`M`) is taken from every other app while it is bound.
 *
 * `globalShortcut` has no key-up event, so push to talk stays in the focused
 * window (the renderer's keydown/keyup).
 */

export const MAX_GLOBAL_SHORTCUTS = 8;

const MODIFIERS = new Set(["CommandOrControl", "Control", "Alt", "Shift"]);
const KEY =
  /^(?:[A-Z0-9]|[[\]`\-=\\;',./]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|num[0-9]|numadd|numsub|nummult|numdiv|numdec)$/;
const ACTION = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

export function isAllowedAccelerator(accelerator: string): boolean {
  const parts = accelerator.split("+");
  // A `+` key would split into empty parts; it is not allowed.
  if (parts.some((p) => p === "")) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!KEY.test(key)) return false;
  if (new Set(mods).size !== mods.length) return false;
  return mods.every((m) => MODIFIERS.has(m));
}

/** The checked payload. Throws on a bad shape, a bad action or a refused accelerator. */
export function validateGlobalShortcuts(input: unknown): GlobalShortcutInfo[] {
  if (!Array.isArray(input) || input.length > MAX_GLOBAL_SHORTCUTS)
    throw new Error("global shortcuts: not a list, or too long");
  return input.map((s: unknown) => {
    const { action, accelerator } = (s ?? {}) as Record<string, unknown>;
    if (typeof action !== "string" || !ACTION.test(action))
      throw new Error("global shortcuts: bad action");
    if (typeof accelerator !== "string" || !isAllowedAccelerator(accelerator))
      throw new Error(
        `global shortcuts: refused accelerator ${String(accelerator)}`,
      );
    return { action, accelerator };
  });
}

/** The part of Electron `globalShortcut` that this module uses. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregisterAll(): void;
}

export interface GlobalShortcuts {
  /** Replaces every registration with `input`. Returns the actions that the OS refused. */
  set(input: unknown): string[];
  /** Lets every shortcut go (quit, window closed). */
  clear(): void;
}

export function createGlobalShortcuts(
  registry: ShortcutRegistry,
  fire: (action: string) => void,
): GlobalShortcuts {
  return {
    set(input) {
      const list = validateGlobalShortcuts(input);
      registry.unregisterAll();
      const refused: string[] = [];
      for (const { action, accelerator } of list) {
        let ok = false;
        try {
          ok = registry.register(accelerator, () => fire(action));
        } catch {
          ok = false;
        }
        if (!ok) refused.push(action);
      }
      return refused;
    },
    clear: () => registry.unregisterAll(),
  };
}
