const fs = require("fs");
const path = require("path");

// @discordjs/opus ships prebuilds for Node but not Electron.
// Since the binary uses NAPI (ABI-stable), the Node prebuild works
// in Electron — we just need to symlink it to the path that
// node-pre-gyp expects at runtime inside Electron.

const opusPkgPath = require.resolve("@discordjs/opus/package.json");
const prebuildDir = path.join(path.dirname(opusPkgPath), "prebuild");

if (!fs.existsSync(prebuildDir)) {
  console.warn(
    `No prebuild directory found at ${prebuildDir}, skipping symlink`,
  );
  process.exit(0);
}

const nodePrebuild = fs
  .readdirSync(prebuildDir)
  .find((entry) => entry.startsWith("node-"));

if (!nodePrebuild) {
  console.warn("No node prebuild found for @discordjs/opus, skipping symlink");
  process.exit(0);
}

const electronVersion = require("electron/package.json").version;
const majorMinor = electronVersion.split(".").slice(0, 2).join(".");
const electronPrebuild = nodePrebuild.replace(
  /^node-v[\d.]+/,
  `electron-v${majorMinor}`,
);

const target = path.join(prebuildDir, electronPrebuild);

if (fs.existsSync(target)) {
  console.log(`Opus Electron prebuild already exists: ${electronPrebuild}`);
  process.exit(0);
}

fs.symlinkSync(nodePrebuild, target);
console.log(`Symlinked opus prebuild: ${electronPrebuild} -> ${nodePrebuild}`);
