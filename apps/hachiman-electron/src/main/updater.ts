/**
 * Auto-update from the GitHub Actions artifacts of .github/workflows/desktop.yml, through
 * Takusen (contract §4 Desktop updates): Takusen holds the GitHub token, this app holds none.
 * CI bakes the build commit into MAIN_VITE_BUILD_SHA. A build without it (dev, local
 * packaging) never checks.
 */
import { app, dialog, shell } from "electron";
import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { createWriteStream } from "fs";
import { access, constants, mkdtemp, readdir } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream } from "stream/web";
import { promisify } from "util";
import { resolveTakusenEnv } from "@hachiman/hachiman/takusen-env";

const env: Readonly<Record<string, unknown>> = { ...import.meta.env };
const BUILD_SHA = env["MAIN_VITE_BUILD_SHA"];
const PLATFORM = (
  { darwin: "macos", win32: "windows" } as Record<string, string>
)[process.platform];
const UPDATE_URL = `${resolveTakusenEnv(env).apiBase}/desktop-update/${PLATFORM}`;
const INSTALLER_EXT = process.platform === "win32" ? ".exe" : ".dmg";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// bsdtar reads zip on both platforms. On Windows, take the System32 one: a Git Bash tar on PATH is GNU tar.
const TAR =
  process.platform === "win32"
    ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
    : "/usr/bin/tar";
// macOS: wait for the app to exit, swap the bundle, unmount, relaunch. Args: pid, app, new app, mount.
const MAC_SWAP_SCRIPT =
  'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; ' +
  'ditto "$3" "$2.new" && rm -rf "$2" && mv "$2.new" "$2"; ' +
  'hdiutil detach "$4" -quiet; open "$2"';

const run = promisify(execFile);
// The build the user already saw a prompt for, so a "Later" is not asked again every interval.
let offeredSha: string | null = null;

export function startUpdater(): void {
  if (
    !app.isPackaged ||
    typeof BUILD_SHA !== "string" ||
    !BUILD_SHA ||
    !PLATFORM
  )
    return;
  const tick = (): void => {
    check().catch((e: unknown) =>
      console.warn("[hachiman] update check failed", e),
    );
  };
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}

async function check(): Promise<void> {
  const res = await fetch(UPDATE_URL);
  if (res.status === 404) return; // updates not configured, or no build yet
  if (!res.ok) throw new Error(`update info: HTTP ${res.status}`);
  const { sha, sha256 } = (await res.json()) as { sha: string; sha256: string };
  if (sha === BUILD_SHA || sha === offeredSha) return;

  const installer = await download(sha256);
  offeredSha = sha;
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: "A new version of Hachiman is ready.",
    detail: `Build ${sha.slice(0, 7)}. Hachiman restarts to install it.`,
  });
  if (response !== 0) return;
  try {
    await install(installer);
  } catch (e) {
    dialog.showErrorBox("Hachiman update failed", String(e));
  }
}

/** Downloads the artifact zip, checks its SHA-256, and unpacks it. Returns the installer path. */
async function download(sha256: string): Promise<string> {
  const res = await fetch(`${UPDATE_URL}/download`);
  if (!res.ok || !res.body)
    throw new Error(`update download: HTTP ${res.status}`);
  const dir = await mkdtemp(join(tmpdir(), "hachiman-update-"));
  const zip = join(dir, "update.zip");
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as ReadableStream),
    tap,
    createWriteStream(zip),
  );
  // Fails closed. A build that landed between the info and the download call also fails here and retries next check.
  if (hash.digest("hex") !== sha256) throw new Error("update digest mismatch");

  await run(TAR, ["-xf", zip, "-C", dir]);
  const file = (await readdir(dir)).find((f) => f.endsWith(INSTALLER_EXT));
  if (!file) throw new Error(`update has no ${INSTALLER_EXT}`);
  return join(dir, file);
}

async function install(installer: string): Promise<void> {
  if (process.platform === "win32") {
    // electron-builder NSIS: /S installs silently over this install, --force-run starts the app after.
    spawn(installer, ["/S", "--force-run"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    app.quit();
    return;
  }

  // macOS: the builds are unsigned, so Squirrel.Mac refuses them. Swap the bundle ourselves.
  const appPath = resolve(app.getPath("exe"), "../../.."); // <App>.app/Contents/MacOS/<exe>
  const mount = join(dirname(installer), "mnt");
  await run("/usr/bin/hdiutil", [
    "attach",
    installer,
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
  ]);
  const bundle = (await readdir(mount)).find((f) => f.endsWith(".app"));
  if (!bundle) throw new Error("dmg has no .app");
  try {
    await access(dirname(appPath), constants.W_OK);
  } catch {
    // No write access to the install folder: show the dmg so the user drags the app in.
    await shell.openPath(mount);
    return;
  }
  spawn(
    "/bin/sh",
    [
      "-c",
      MAC_SWAP_SCRIPT,
      "sh",
      String(process.pid),
      appPath,
      join(mount, bundle),
      mount,
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
  app.quit();
}
