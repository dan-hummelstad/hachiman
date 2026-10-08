/** Unit tests for ./app-prefs.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppPrefsStore, parseAppPrefs } from "./app-prefs.ts";

test("parseAppPrefs: defaults for a missing or bad value", () => {
  assert.deepEqual(parseAppPrefs(null), { closeToTray: true });
  assert.deepEqual(parseAppPrefs({ closeToTray: "no" }), { closeToTray: true });
  assert.deepEqual(parseAppPrefs({ closeToTray: false, x: 1 }), {
    closeToTray: false,
  });
});

test("store: defaults without a file, then persists a change", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "app-prefs-"));
  try {
    const store = createAppPrefsStore(dir);
    assert.equal(store.get().closeToTray, true);
    await store.set({ closeToTray: false });
    assert.equal(store.get().closeToTray, false);
    assert.equal(createAppPrefsStore(dir).get().closeToTray, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("store: a corrupt file gives the defaults", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "app-prefs-"));
  try {
    await fs.writeFile(join(dir, "app-prefs.json"), "{not json");
    assert.equal(createAppPrefsStore(dir).get().closeToTray, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
