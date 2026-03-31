# Talkover

Record your browser tab as a polished video with webcam overlay — or export as an animated GIF. One click to capture demos, tutorials, bug reports, and walkthroughs, right from your browser.

**Zero dependencies. Zero accounts. Zero cloud.** Everything runs locally using browser APIs.

![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![Version](https://img.shields.io/badge/version-1.0.0-7c3aed)
![License](https://img.shields.io/badge/license-MIT-blue)

## Why Talkover?

Most screen recorders need accounts, cloud uploads, or desktop apps. Talkover is different:

- **Record + webcam in one click** — your face overlaid on your tab, tutorial-style
- **No sign-up, no cloud** — recordings never leave your machine
- **GIF + Video** — export as animated GIF or full-quality WebM with audio
- **Lightweight** — under 100KB total, pure browser APIs, no build tools

Perfect for developers sharing bug reproductions, educators making walkthroughs, designers demoing flows, or anyone who needs a quick screen capture with a personal touch.

## Features

### Recording
- **Tab capture** — records the active browser tab at its native resolution using the Chrome tabCapture API
- **Webcam overlay** — picture-in-picture webcam feed composited onto your recording (circle, square, or rectangle shape; any corner position)
- **Microphone audio** — record your voice narration alongside the screen
- **Tab audio** — capture audio playing in the tab (music, video, app sounds)
- **Audio mixing** — mic and tab audio mixed together via Web Audio API
- **Custom cursor** — crisp SVG cursor overlay that renders cleanly in recordings (no blurry native cursor)

### Editing
- **Trim timeline** — drag handles to select the exact clip range before exporting
- **Live preview** — plays back your recording immediately with webcam overlay

### Export
- **Animated GIF** — configurable FPS, scale, quality, and looping
- **WebM video** — full-quality video with composited webcam and audio
- **Instant download** — timestamped filename, no upload required

### Settings
| Setting | Options | Default |
|---------|---------|---------|
| GIF Frame Rate | 5, 10, 15, 24, 30 fps | 10 fps |
| Scale | 100%, 75%, 50%, 25% | 100% |
| Quality | Low, Med, High | Med |
| Cursor | on / off | on |
| Loop GIF | on / off | on |
| Webcam Position | TL, TR, BL, BR | BR |
| Webcam Shape | Rectangle, Square, Circle | Rectangle |

All settings persist across sessions.

### Extras
- **Keyboard shortcut** — `Alt+Shift+R` to start/stop recording without opening the popup
- **Offline GIF encoder** — median-cut color quantization + LZW compression in a Web Worker
- **Permission flow** — dedicated page for granting mic/camera access (popups can't show permission prompts)

## Install

### From source (Developer mode)

1. Clone this repository
   ```bash
   git clone https://github.com/AhmadYasser/site2gif.git
   ```
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder
5. Pin the extension to your toolbar

### From Chrome Web Store

_Coming soon._

## Usage

1. Click the Talkover icon in your toolbar
2. Toggle **Webcam** and/or **Audio** if you want them
3. Press the **Record** button (or `Alt+Shift+R`)
4. Interact with your tab — everything is being captured
5. Press **Stop**
6. Trim if needed, then **Save as GIF** or **Save as Video**

The file downloads instantly with a timestamped filename.

## Architecture

```
popup.html/js/css    UI — controls, preview, trim, webcam overlay, export
background.js        Service worker — state machine, tab capture, message routing
offscreen.js         Offscreen document — MediaRecorder, stream capture, blob storage
gif-worker.js        Web Worker — frame quantization, LZW compression, GIF89a encoding
content.js           Content script — SVG cursor overlay on the recorded tab
db.js                IndexedDB wrapper — stores video, webcam, and GIF blobs
permissions.html/js  Dedicated page for mic/camera permission prompts
```

### Recording flow

```
                   ┌─────────────────────────────────────────────┐
  User clicks      │  background.js                              │
  Record ─────────>│  tabCapture.getMediaStreamId()              │
                   │  reads tab dimensions (width × height)      │
                   │  sends config to offscreen document         │
                   └──────────────┬──────────────────────────────┘
                                  │
                   ┌──────────────v──────────────────────────────┐
                   │  offscreen.js                               │
                   │  getUserMedia(tab stream at native res)     │
                   │  getUserMedia(webcam) ─> separate recorder  │
                   │  getUserMedia(mic)                          │
                   │  mix tab audio + mic via Web Audio API      │
                   │  MediaRecorder(tab video + mixed audio)     │
                   │  MediaRecorder(webcam video)                │
                   │  ──> blobs saved to IndexedDB               │
                   └──────────────┬──────────────────────────────┘
                                  │
                   ┌──────────────v──────────────────────────────┐
  User sees        │  popup.js (done view)                       │
  preview ─────────│  loads tab video from IndexedDB             │
                   │  loads webcam video from IndexedDB          │
                   │  overlays webcam via CSS (same as live)     │
                   │  trim handles adjust clip range             │
                   └──────────────┬──────────────────────────────┘
                                  │
                   ┌──────────────v──────────────────────────────┐
  User clicks      │  popup.js (export)                          │
  Save ───────────>│  GIF: frame-by-frame canvas + webcam PIP   │
                   │       quantize + LZW in Web Worker          │
                   │  Video: canvas composite + MediaRecorder    │
                   │       (in visible popup — not offscreen)    │
                   │  ──> download                               │
                   └─────────────────────────────────────────────┘
```

### Why compositing happens in the popup

Chrome's `canvas.captureStream()` is broken in offscreen/hidden documents ([Chromium #41270855](https://issues.chromium.org/issues/41270855), [#41279417](https://issues.chromium.org/issues/41279417)). Tab and webcam streams are recorded separately in the offscreen document, then composited during export in the popup where the canvas rendering pipeline is active.

## How the GIF encoder works

The extension includes a from-scratch GIF89a encoder (no libraries):

1. **Frame extraction** — each frame drawn to canvas at configured FPS and scale, with webcam PIP overlay
2. **Median-cut quantization** — reduces each frame to a 256-color palette by recursively splitting the color space
3. **Transparency optimization** — pixels unchanged from the previous frame are marked transparent, reducing file size
4. **LZW compression** — standard GIF compression on the indexed pixel data
5. **Binary assembly** — header, logical screen descriptor, application extension (for looping), and frame blocks assembled into valid GIF89a

All encoding runs in a Web Worker with progress updates streamed back to the UI.

## Permissions

| Permission | Why |
|------------|-----|
| `tabCapture` | Capture the active tab as a media stream |
| `activeTab` | Access the current tab for capture and cursor injection |
| `offscreen` | Run MediaRecorder in a background document (MV3 requirement) |
| `storage` | Persist user settings across sessions |
| `scripting` | Inject the cursor overlay script into the recorded tab |

**No data leaves your browser.** Recordings are stored temporarily in IndexedDB and never uploaded anywhere.

## Privacy

Talkover does not collect, transmit, or store any personal data. All recordings exist only in your browser's local IndexedDB and are cleared when you start a new recording. No analytics, no telemetry, no network requests.

## Contributing

Contributions are welcome! Please open an issue or pull request.

## License

MIT
