# Cutting Room

A local desktop app for organizing, comparing, and bulk-editing photo albums. Built with Tauri (Rust) + React/TypeScript.

## Features

- **Album** — load a folder of photos, tag them (needs-editing / favorite), drag to reorder, rename the album (and optionally the photo files to match), single-click / Shift-click / Ctrl-click selection, copy selected photos to the clipboard for pasting into Explorer, delete to the Recycle Bin, and a full-screen image viewer with keyboard navigation.
- **Matching** — compare every photo in one folder against a second folder and find each one's closest visual match by perceptual hash, resolution-independent (useful for tracking down an original, un-upscaled file). Review the matches, then copy the ones you want into a destination folder.
- **Detection** — run a YOLO (Ultralytics) model over a folder of photos, review the detected regions (toggle individual boxes or whole classes on/off), then pixelate the confirmed regions into an output folder. Originals are never modified.
- **Strip Metadata** — recursively remove EXIF and other metadata from every image in a folder and its subfolders.
- **Generate** — text-to-image generation through your NovelAI account, limited to settings that are free on an Opus subscription. Supports batches, prompts loaded from a text file, importing settings from a NovelAI image, and Vibe Transfer with vibe files you've already encoded on NovelAI (`.naiv4vibe` / `.naiv4vibebundle`, V4 and V4.5 models, up to four at a time so it stays free).

Each tab keeps its own state — switching between them doesn't lose an open folder or an in-progress operation.

## MCP server (let an AI assistant generate images)

`mcp-server/` builds `cutting-room-mcp.exe`, a local [MCP](https://modelcontextprotocol.io) server that lets an MCP client — Claude Code, Claude Desktop, or any other MCP-capable app on this PC — generate images through your NovelAI account and look at the results. It offers three tools:

- `novelai_account_status` — tier, Anlas, and Opus V5 quota (read-only).
- `novelai_generate_image` — generates one image and returns a preview; the full PNG is saved to the output folder, or to a folder the assistant names (`output_dir`, a full local path shown in the approval dialog). Optionally applies up to four vibes from vibe files you've already encoded (V4 and V4.5 models); a vibe that would need a paid encode is refused.
- `novelai_list_vibes` — lists the vibes in a vibe file and which models they're encoded for (read-only, nothing sent to NovelAI).

**Every image needs your approval** in a Windows dialog showing the full request (including any vibe files) and whether it costs Anlas ("No" is the default button). The server uses the same limits as the Generate tab — free sizes and step counts only, at least 2 seconds between requests, and a stop if NovelAI unexpectedly charges Anlas. It reads the token Cutting Room saved in Windows Credential Manager, so log in once in the Generate tab first; the token is never passed to the AI client.

Build it:

```bash
cd mcp-server
cargo build --release   # -> mcp-server/target/release/cutting-room-mcp.exe
```

Register it with Claude Code (use your own paths; `--output-dir` is optional and defaults to `Pictures\Cutting Room MCP`):

```bash
claude mcp add cutting-room-novelai --scope user -- "C:\path\to\cutting-room-mcp.exe" --output-dir "C:\path\to\output"
```

Or with Claude Desktop, in `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cutting-room-novelai": {
      "command": "C:\\path\\to\\cutting-room-mcp.exe",
      "args": ["--output-dir", "C:\\path\\to\\output"]
    }
  }
}
```

The NovelAI client code is shared between the app and the server in `crates/novelai-core`.

## Development

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # build a distributable installer/executable
```

Detection requires a Python environment with `ultralytics`, `torch`, and `opencv-python` installed, plus at least one YOLO `.pt` weights file — both are configured from within the Detection tab.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
