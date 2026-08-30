# Cutting Room

A local desktop app for organizing, comparing, and bulk-editing photo albums. Built with Tauri (Rust) + React/TypeScript.

## Features

- **Album** — load a folder of photos, tag them (needs-editing / favorite), drag to reorder, rename the album (and optionally the photo files to match), single-click / Shift-click / Ctrl-click selection, copy selected photos to the clipboard for pasting into Explorer, delete to the Recycle Bin, and a full-screen image viewer with keyboard navigation.
- **Matching** — compare every photo in one folder against a second folder and find each one's closest visual match by perceptual hash, resolution-independent (useful for tracking down an original, un-upscaled file). Review the matches, then copy the ones you want into a destination folder.
- **Detection** — run a YOLO (Ultralytics) model over a folder of photos, review the detected regions (toggle individual boxes or whole classes on/off), then pixelate the confirmed regions into an output folder. Originals are never modified.

Each tab keeps its own state — switching between them doesn't lose an open folder or an in-progress operation.

## Development

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # build a distributable installer/executable
```

Detection requires a Python environment with `ultralytics`, `torch`, and `opencv-python` installed, plus at least one YOLO `.pt` weights file — both are configured from within the Detection tab.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
