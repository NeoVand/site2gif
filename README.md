# site2gif

A Chrome extension that captures your browser tab as an animated GIF or video — perfect for quick demos, tutorials, and thumbnails.

**Zero dependencies.** Built entirely with browser APIs and custom algorithms (median-cut color quantization, LZW compression, GIF89a encoding).

![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![Version](https://img.shields.io/badge/version-1.0.0-7c3aed)

## Features

- **Tab capture** — records the active browser tab using the Chrome tabCapture API
- **Dual export** — save as animated GIF or WebM video
- **Trim timeline** — drag handles to select the exact clip range before exporting
- **Custom cursor overlay** — renders a crisp SVG cursor on top of the recording (no blurry native cursor)
- **Configurable settings** — frame rate, scale, quality, cursor visibility, and loop behavior
- **Keyboard shortcut** — `Alt+Shift+R` to start/stop recording without opening the popup
- **Offline GIF encoder** — frame extraction, color quantization, and LZW compression all run in a Web Worker
- **Live preview** — toggle between video and GIF preview after recording

## Install

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder
5. Pin the extension to your toolbar for quick access

## Usage

1. Click the extension icon to open the popup
2. Press **Record** (or `Alt+Shift+R`)
3. Do your thing in the tab
4. Press **Stop**
5. Optionally trim using the timeline handles
6. Click **Save as GIF** or **Save as Video**

The file downloads automatically with a timestamped filename.

## Settings

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| GIF Frame Rate | 5, 10, 15, 24, 30 fps | 10 fps | Controls animation smoothness and file size |
| Scale | 100%, 75%, 50%, 25% | 100% | Output resolution — lower = smaller files |
| Quality | Low, Med, High | Med | Color quantization depth |
| Show Cursor | on/off | on | Overlay a custom cursor during recording |
| Loop GIF | on/off | on | Infinite loop vs. single play |

Settings persist across sessions via `chrome.storage.local`.

## Architecture

```
popup.html/js/css    UI — recording controls, preview, trim, settings, download
background.js        Service worker — state machine, message routing, badge updates
offscreen.js         Offscreen document — MediaRecorder, stream capture, blob storage
gif-worker.js        Web Worker — frame quantization, LZW compression, GIF89a assembly
content.js           Content script — injects SVG cursor overlay on the recorded tab
db.js                IndexedDB wrapper — stores video and GIF blobs
```

**Recording flow:**

```
Record → background.js gets tab stream via tabCapture
       → offscreen.js runs MediaRecorder, collects WebM chunks
       → blob saved to IndexedDB

Stop   → popup.js loads video for preview + trim

Export → popup.js extracts frames to canvas (respecting trim range)
       → gif-worker.js quantizes colors, encodes GIF89a with LZW
       → downloads the result
```

## How GIF encoding works

The extension includes a from-scratch GIF89a encoder:

1. **Frame extraction** — each frame is drawn to an offscreen canvas at the configured FPS and scale
2. **Median-cut quantization** — reduces each frame to a 256-color palette by recursively splitting the color space
3. **Transparency optimization** — pixels unchanged from the previous frame are marked transparent, reducing file size
4. **LZW compression** — standard GIF compression applied to the indexed pixel data
5. **Binary assembly** — header, logical screen descriptor, application extension (for looping), and frame blocks are assembled into a valid GIF89a binary

All encoding runs in a Web Worker to keep the UI responsive, with progress updates streamed back to the popup.

## Permissions

| Permission | Why |
|------------|-----|
| `tabCapture` | Capture the active tab as a media stream |
| `activeTab` | Access the current tab for capture and cursor injection |
| `offscreen` | Create an offscreen document for MediaRecorder (Manifest V3 requirement) |
| `storage` | Persist user settings |
| `scripting` | Inject the cursor overlay script into the recorded tab |
