import {
  desktopCapturer,
  ipcMain,
  session,
  type DesktopCapturerSource,
  type Streams,
} from "electron";
import {
  SCREEN_SOURCES_CHANNEL,
  SELECT_SCREEN_SOURCE_CHANNEL,
  type ScreenSourceInfo,
} from "../shared/ipc";

/**
 * Screen share without the OS picker: the renderer lists sources, the user
 * picks one in the in-app picker, then getDisplayMedia captures exactly that
 * source. Electron rejects getDisplayMedia without a request handler.
 *
 * Accepted risk: script running in the app page (e.g. after an XSS) can list
 * and select a source itself, so it can capture a window without the user
 * seeing a picker. The checks below only keep subframes and stale or unknown
 * ids out.
 */
export function registerScreenShare(isAppUrl: (url: string) => boolean): void {
  let listed = new Map<string, DesktopCapturerSource>();
  // One shot: the next getDisplayMedia call takes it. A new listing clears a
  // selection that no capture used.
  let selected: DesktopCapturerSource | null = null;
  let selectedAudio = false;

  ipcMain.handle(
    SCREEN_SOURCES_CHANNEL,
    async (): Promise<ScreenSourceInfo[]> => {
      selected = null;
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
      });
      listed = new Map(sources.map((s) => [s.id, s]));
      return sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith("screen:") ? "screen" : "window",
        thumbnail: `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString("base64")}`,
      }));
    },
  );

  ipcMain.handle(
    SELECT_SCREEN_SOURCE_CHANNEL,
    (_e, id: unknown, audio: unknown) => {
      selected = (typeof id === "string" && listed.get(id)) || null;
      selectedAudio = audio === true;
      if (!selected) throw new Error("unknown screen source");
    },
  );

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const source = selected;
    const audio = selectedAudio && request.audioRequested;
    selected = null;
    selectedAudio = false;
    const { frame } = request;
    const fromApp =
      frame !== null && frame.parent === null && isAppUrl(frame.url);
    // An empty answer rejects getDisplayMedia.
    callback(source && fromApp ? displayStreams(source, audio) : {});
  });
}

/**
 * The system audio comes from loopback, which this Electron supports on
 * Windows only (electron.d.ts, `Streams.audio`). Elsewhere the share is video
 * only, even when audio was asked for. Not `loopbackWithMute`: the sharer
 * still hears the system. The renderer's `restrictOwnAudio` keeps the call
 * itself out of the capture where Chromium supports it.
 */
export function displayStreams(
  source: DesktopCapturerSource,
  audio: boolean,
  platform: NodeJS.Platform = process.platform,
): Streams {
  return audio && platform === "win32"
    ? { video: source, audio: "loopback" }
    : { video: source };
}
