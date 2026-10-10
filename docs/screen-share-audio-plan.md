# Screen share audio: no call audio, per-app audio

Status: problem 1 is fixed (Electron 44). Problem 2 is a proposal. Nothing for problem 2 is built.

## Problems

1. When a user shares a screen with audio, the stream includes the Hachiman call audio. The viewers hear their own voices again.
2. When a user shares one app window, the stream includes the audio of the full system, not only the audio of that app.

## Problem 1: call audio in the stream (fixed)

On Windows, `apps/hachiman-electron/src/main/screen-share.ts` answers `getDisplayMedia` with `audio: 'loopback'`. Loopback captures all audio that goes to the output device. That audio includes the call.

The renderer asks for `restrictOwnAudio: true` (`SCREEN_AUDIO` in `apps/hachiman/src/services/VoiceService.ts`). Electron 39 ignored this constraint in a custom display-media handler. Electron 43.4 and later (electron/electron#52455) honor it: when the handler answers `loopback`, Electron captures `loopbackWithoutChrome` instead. This is the system audio without the audio of the Hachiman process tree (WASAPI process loopback, exclude mode). The app now uses Electron 44, so no code change and no native module are necessary.

Limits:

- Windows 10 2004 and later only. Older Windows versions capture the full system, as before.
- Electron supports loopback only on Windows. On macOS and Linux, the share is video only.

## Problem 2: per-app audio for a window share (open)

Chromium has Windows application loopback for a window share: it finds the process of the selected window and captures only the audio of that process tree. Electron does not expose it. `Streams.audio` accepts only `loopback`, `loopbackWithMute` or a `WebFrameMain`. electron/electron#54628 asks for an `application` audio option. It is open and has no pull request.

There are two options:

- **Wait for Electron.** When Electron exposes application audio, answer a window share with it. This is a small change in `displayStreams`.
- **Native module.** Use WASAPI process loopback (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) in include mode. The design follows.

### Native design (Windows)

1. Get the window handle (HWND) from the desktopCapturer source id `window:<HWND>:0`.
2. Get the process id with `GetWindowThreadProcessId`.
3. Capture that process tree in include mode. The process tree is important: Electron apps and browsers play audio from a child process, not from the main process.
4. If the shared window belongs to Hachiman, send no audio.

Data path:

1. A native addon in the Electron main process starts the capture and receives PCM frames.
2. Main sends the frames to the renderer on a `MessagePort`.
3. The renderer writes the frames into an `AudioWorklet`, then into a `MediaStreamAudioDestinationNode`.
4. The renderer puts the track of that node on the existing screen audio sender.

The wire and the contract (`docs/gateway-protocol.md`) do not change. The SFrame transform on the screen audio sender stays the same. If the addon fails to load, use the current `loopback` capture.

Open decisions for the native option:

- **Own addon or third-party addon.** The addon runs in the main process. An own small addon is easier to audit. A third-party addon needs a security review before use.
- **Build.** A native addon needs a native build step in CI and prebuilt binaries for each Electron ABI.
- **Format.** Use 48 kHz stereo, which matches Opus. Pick a frame size for the `MessagePort` transfer.
- **Security.** The addon must accept only a source that the picker selected. It must not accept a free process id from the renderer.

## Out of scope

- Linux share audio.
- macOS share audio. It needs Electron loopback support on macOS, or a native module that uses Core Audio process taps (macOS 14.2 and later).
