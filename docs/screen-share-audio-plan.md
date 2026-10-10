# Screen share audio: no call audio, per-app audio

Status: proposal. Nothing in this document is built.

## Problems

1. When a user shares a screen with audio, the stream includes the Hachiman call audio. The viewers hear their own voices again.
2. When a user shares one app window, the stream includes the audio of the full system, not only the audio of that app.

## Cause

On Windows, `apps/hachiman-electron/src/main/screen-share.ts` answers `getDisplayMedia` with `audio: 'loopback'`. Loopback captures all audio that goes to the output device. That audio includes the call.

The renderer asks for `restrictOwnAudio: true` (`SCREEN_AUDIO` in `apps/hachiman/src/services/VoiceService.ts`). This constraint has no effect on the Electron loopback path.

Electron 39 gives only two audio options for a display capture: `loopback` and `loopbackWithMute`. Electron supports both only on Windows. Neither option can exclude a process or capture only one process. Thus Electron alone cannot fix the two problems.

## Platform support

| Platform | Share audio today | Fix possible |
| --- | --- | --- |
| Windows 10 2004 and later | Full system loopback | Yes, with a native module (WASAPI process loopback) |
| Windows before 10 2004 | Full system loopback | No. Keep the current behavior. |
| macOS | No share audio | Yes on macOS 14.2 and later, with a different native module (Core Audio process taps). Follow-up. |
| Linux | No share audio | Not in scope |
| Browser host | Chrome picker: one tab, or the full system | No. The browser controls the capture. |

## Design (Windows)

WASAPI process loopback (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) captures the audio of one process tree. It has two modes:

- **Exclude mode.** Capture all system audio except the audio of a process tree.
- **Include mode.** Capture only the audio of a process tree.

The process tree is important. Electron apps and browsers play audio from a child process, not from the main process.

### Screen share

Use exclude mode with the Hachiman process tree. The stream gets the game and music audio, but not the call audio.

### Window share

Use include mode with the process tree of the shared window:

1. Get the window handle (HWND) from the desktopCapturer source id `window:<HWND>:0`.
2. Get the process id with `GetWindowThreadProcessId`.
3. Capture that process tree in include mode.

If the shared window belongs to Hachiman, send no audio.

### Data path

1. A native addon in the Electron main process starts the process loopback capture and receives PCM frames.
2. Main sends the frames to the renderer on a `MessagePort`.
3. The renderer writes the frames into an `AudioWorklet`, then into a `MediaStreamAudioDestinationNode`.
4. The renderer puts the track of that node on the existing screen audio sender.

The wire does not change, and the contract (`docs/gateway-protocol.md`) does not change. The SFrame transform on the screen audio sender stays the same.

### Fallback

If the addon fails to load or the OS is older than Windows 10 2004, use the current `loopback` capture.

## Open decisions

- **Own addon or third-party addon.** The addon runs in the main process. An own small addon is easier to audit. A third-party addon needs a security review before use.
- **Build.** A native addon needs a native build step in CI and prebuilt binaries for each Electron ABI.
- **Format.** Pick the sample rate and channel count (48 kHz stereo matches Opus) and a frame size for the `MessagePort` transfer.
- **Security.** Today, a script in the app page can select any listed source (the accepted risk in `screen-share.ts`). The addon must accept only a source that the picker selected. It must not accept a free process id from the renderer.

## Out of scope

- Linux share audio.
