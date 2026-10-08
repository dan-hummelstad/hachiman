/**
 * The tray (menu bar on macOS) icon. With the close-to-tray setting (./app-prefs.ts)
 * the close button hides the main window, and the tray brings it back or quits.
 */
import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";
import appIcon from "../../resources/icon.png?asset";
// macOS loads the @2x sibling next to this file by itself.
import templateIcon from "../../resources/trayTemplate.png?asset";

// Module-scoped so that GC does not remove the icon.
let tray: Tray | null = null;

export function revealWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** `openWindow` shows the main window, or makes one when there is none. */
export function createTray(openWindow: () => void): void {
  if (tray) return;
  const image =
    process.platform === "darwin"
      ? nativeImage.createFromPath(templateIcon)
      : nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 });
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Hachiman");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Hachiman", click: openWindow },
      { type: "separator" },
      { label: "Quit Hachiman", click: () => app.quit() },
    ]),
  );
  // Windows and Linux: a left click opens the window. macOS opens the menu.
  if (process.platform !== "darwin") tray.on("click", openWindow);
}
