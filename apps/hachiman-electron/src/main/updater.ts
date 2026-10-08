/**
 * Auto-update from the newest release of the release repository (.github/workflows/desktop.yml), through
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
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream } from "stream/web";
import { promisify } from "util";
import { resolveTakusenEnv } from "@hachiman/hachiman/takusen-env";
import type { UpdateCheckResult } from "../shared/ipc";

interface Target {
  /** `:platform` of the Takusen route. */
  name: string;
  installerExt: string;
  /** bsdtar, which reads zip. On Windows the System32 one: a Git Bash tar on PATH is GNU tar. */
  tar: string;
  install: (installer: string) => Promise<void>;
}

const TARGETS: Partial<Record<NodeJS.Platform, Target>> = {
  win32: {
    name: "windows",
    installerExt: ".exe",
    tar: join(
      process.env["SystemRoot"] ?? "C:\\Windows",
      "System32",
      "tar.exe",
    ),
    install: installWindows,
  },
  darwin: {
    name: "macos",
    installerExt: ".dmg",
    tar: "/usr/bin/tar",
    install: installMac,
  },
};

const env: Readonly<Record<string, unknown>> = { ...import.meta.env };
const BUILD_SHA = String(env["MAIN_VITE_BUILD_SHA"] ?? "");
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// macOS: wait for the app to exit, swap the bundle, unmount, relaunch. Args: pid, app, new app, mount.
const MAC_SWAP_SCRIPT =
  'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; ' +
  'ditto "$3" "$2.new" && rm -rf "$2" && mv "$2.new" "$2"; ' +
  'hdiutil detach "$4" -quiet; open "$2"';

const run = promisify(execFile);
// The build the user already saw a prompt for, so a "Later" is not asked again every interval.
// A manual check asks again.
let offeredSha: string | null = null;
// One check at a time: the timer and the settings button share it.
let checking: Promise<UpdateCheckResult> | null = null;

export function startUpdater(): void {
  if (!app.isPackaged || !BUILD_SHA || !TARGETS[process.platform]) return;
  const tick = (): void => {
    void checkForUpdate(false).then((r) => {
      if (r.status === "failed")
        console.warn("[hachiman] update check failed", r.reason);
    });
  };
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}

/** `manual`: the user asked (settings), so a build they put off with "Later" is offered again. */
export function checkForUpdate(manual: boolean): Promise<UpdateCheckResult> {
  checking ??= runCheck(manual).finally(() => {
    checking = null;
  });
  return checking;
}

async function runCheck(manual: boolean): Promise<UpdateCheckResult> {
  const target = TARGETS[process.platform];
  if (!app.isPackaged || !BUILD_SHA || !target) {
    return {
      status: "not-available",
      reason:
        "This build does not update itself (a development or local build).",
    };
  }
  try {
    return await check(target, manual);
  } catch (e) {
    return {
      status: "failed",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function check(
  target: Target,
  manual: boolean,
): Promise<UpdateCheckResult> {
  const build = BUILD_SHA.slice(0, 7);
  const url = `${resolveTakusenEnv(env).apiBase}/desktop-update/${target.name}`;
  const res = await fetch(url);
  if (res.status === 404)
    return {
      status: "not-available",
      reason: "No desktop build is published yet.",
    };
  if (!res.ok) throw new Error(`update info: HTTP ${res.status}`);
  const { sha, sha256 } = (await res.json()) as { sha: string; sha256: string };
  if (sha === BUILD_SHA) return { status: "up-to-date", build };
  const offered = {
    status: "offered",
    build,
    latest: sha.slice(0, 7),
  } as const;
  if (sha === offeredSha && !manual) return offered;

  const installer = await download(target, `${url}/download`, sha256);
  offeredSha = sha;
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: "A new version of Hachiman is ready.",
    detail: `Build ${sha.slice(0, 7)}. Hachiman restarts to install it.`,
  });
  if (response !== 0) return offered;
  try {
    await target.install(installer);
  } catch (e) {
    dialog.showErrorBox("Hachiman update failed", String(e));
    throw e;
  }
  return offered;
}

async function download(
  target: Target,
  url: string,
  sha256: string,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body)
    throw new Error(`update download: HTTP ${res.status}`);
  const dir = await mkdtemp(join(tmpdir(), "hachiman-update-"));
  const zip = join(dir, "update.zip");
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body as ReadableStream),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(zip),
  );
  // Fails closed. A build that landed between the info and the download call also fails here and retries next check.
  if (hash.digest("hex") !== sha256) throw new Error("update digest mismatch");

  await run(target.tar, ["-xf", zip, "-C", dir]);
  const file = (await readdir(dir)).find((f) =>
    f.endsWith(target.installerExt),
  );
  if (!file) throw new Error(`update has no ${target.installerExt}`);
  return join(dir, file);
}

// electron-builder NSIS: /S installs silently over this install, --force-run starts the app after.
async function installWindows(installer: string): Promise<void> {
  spawn(installer, ["/S", "--force-run"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  app.quit();
}

// The macOS builds are unsigned, so Squirrel.Mac refuses them. Swap the bundle ourselves.
async function installMac(installer: string): Promise<void> {
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
