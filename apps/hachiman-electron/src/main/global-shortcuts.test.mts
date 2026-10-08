import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createGlobalShortcuts,
  isAllowedAccelerator,
  validateGlobalShortcuts,
  type ShortcutRegistry,
} from "./global-shortcuts.ts";

function fakeRegistry(taken: string[] = []) {
  const held = new Map<string, () => void>();
  const registry: ShortcutRegistry = {
    register(accelerator, cb) {
      if (taken.includes(accelerator) || held.has(accelerator)) return false;
      held.set(accelerator, cb);
      return true;
    },
    unregisterAll: () => held.clear(),
  };
  return { registry, held };
}

test("allows accelerators with Ctrl, ⌘ or Alt, and bare F-keys", () => {
  for (const a of [
    "CommandOrControl+Shift+M",
    "Control+Alt+5",
    "Alt+[",
    "CommandOrControl+Up",
    "F13",
    "Shift+F5",
    "CommandOrControl+num0",
  ])
    assert.equal(isAllowedAccelerator(a), true, a);
});

test("refuses typing keys, unknown keys and odd modifiers", () => {
  for (const a of [
    "M",
    "Shift+M",
    "Space",
    "Super+M",
    "CommandOrControl+CommandOrControl+M",
    "CommandOrControl+",
    "CommandOrControl+Plus",
    "CommandOrControl+MediaPlayPause",
    "",
  ])
    assert.equal(isAllowedAccelerator(a), false, a);
});

test("validates the payload shape", () => {
  assert.throws(() => validateGlobalShortcuts("x"));
  assert.throws(() =>
    validateGlobalShortcuts([{ action: "a b", accelerator: "F1" }]),
  );
  assert.throws(() =>
    validateGlobalShortcuts([{ action: "mute", accelerator: "M" }]),
  );
  assert.throws(() =>
    validateGlobalShortcuts(
      Array.from({ length: 9 }, () => ({ action: "a", accelerator: "F1" })),
    ),
  );
  assert.deepEqual(validateGlobalShortcuts([]), []);
});

test("replaces the set, reports refused keys and fires the action", () => {
  const { registry, held } = fakeRegistry(["Alt+D"]);
  const fired: string[] = [];
  const gs = createGlobalShortcuts(registry, (a) => fired.push(a));
  assert.deepEqual(gs.set([{ action: "toggleMute", accelerator: "F1" }]), []);
  const refused = gs.set([
    { action: "toggleMute", accelerator: "CommandOrControl+Shift+M" },
    { action: "toggleDeafen", accelerator: "Alt+D" },
  ]);
  assert.deepEqual(refused, ["toggleDeafen"]);
  assert.deepEqual([...held.keys()], ["CommandOrControl+Shift+M"]);
  held.get("CommandOrControl+Shift+M")?.();
  assert.deepEqual(fired, ["toggleMute"]);
  gs.clear();
  assert.equal(held.size, 0);
});

test("a bad payload keeps the previous set", () => {
  const { registry, held } = fakeRegistry();
  const gs = createGlobalShortcuts(registry, () => undefined);
  gs.set([{ action: "toggleMute", accelerator: "F1" }]);
  assert.throws(() => gs.set([{ action: "toggleMute", accelerator: "M" }]));
  assert.deepEqual([...held.keys()], ["F1"]);
});
