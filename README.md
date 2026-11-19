# Cutting Room

A local desktop app for organizing, comparing, and bulk-editing photo albums. Built with Tauri (Rust) + React/TypeScript.

## Features

- **Generate** — text-to-image generation through your NovelAI account, limited to settings that are free on an Opus subscription. Portrait, landscape and square presets, or a custom size in steps of 64 up to 1024×1024 worth of pixels (e.g. 1344×768). Supports batches, character positions (anywhere on V5; NovelAI's 5×5 grid on V4/V4.5), per-character undesired content, prompt files (text files with one prompt per line, kept in the project's `wildcards` folder by default, optionally paired so one entry fills the main prompt and each character together — see `wildcards/README.md`; used by typing a token like `__hair__` in the prompt, undesired content or any character; each file random or sequential), image to image (start from a picture, with a strength from 0 to 1; the size switches to the picture's shape), importing settings from a NovelAI image, Danbooru tag suggestions as you type in any prompt box (about 80,000 tags with their aliases, bundled with the app so they work offline; Up/Down to choose, Tab or Enter to insert, Esc to close, Ctrl+Space to open), and Vibe Transfer with vibe files you've already encoded on NovelAI (`.naiv4vibe` / `.naiv4vibebundle`, V4 and V4.5 models, up to four at a time so it stays free). Characters: up to 22 on V5 and 6 on V4/V4.5, in a compact list you can collapse, drag to reorder and spread evenly, with a rough token count. Sampler, noise schedule and Variety+. **Prompt automation**, decided image by image before anything is sent (**Preview batch** shows every image's prompts): prompt files nest (`__outfit__` inside another file), weight their lines (`%3 casual clothes`), pick separately with `__colour!__`, and can come from a whole wildcards folder with subfolders (`__outfits/summer__`), with an editor for each file; `$c1$` names the card in slot 1 and `$c1 has male: …$` / `$any lacks …$` add tags only when a character has (or lacks) a tag; `0.6~1.4::tag::` gives a random strength per image; `!tag` protects a tag; scramble, gender swap (with an editable table, per batch or into the form, loading a card's opposite-gender variant when there is one), tag associations, and characters that move through a labelled pool of cards (next, random or shuffled, every N images). **Parameter creep** steps or randomizes seed, steps, guidance, Variety+, sampler and schedule through a batch, inside the free limits. An **artist library** (fixed, K at random, or one after another; per-model), **saved prompts**, a **vibe library** with vibes that rotate per image, **workflow plans** (sets of images, then Emotion / Colorize / Upscale / Strip metadata on each, 25 requests per click), and **Anlas and V5 quota bars**. Every special syntax has a circled-question-mark help tip. Paid extras show their price and ask first: **Precise Reference** (V4.5, 5 Anlas per reference per image; a style reference, or one that comes with a character card) and **encoding an image as a vibe** (2 Anlas, once; saved as a .naiv4vibe file and never paid for twice). **Director tools**: change a character's expression (Emotion) or colorize an image, free on Opus; on a big image you drag out the area to change, and only that is sent and blended back.
- **Album** — load a folder of photos, tag them (needs-editing / favorite / marked for deletion, then delete every marked photo to the Recycle Bin at once), drag to reorder, rename the album (and optionally the photo files to match), single-click / Shift-click / Ctrl-click selection, copy selected photos to the clipboard for pasting into Explorer, delete to the Recycle Bin, and a full-screen image viewer with keyboard navigation. Right-click a photo to change its expression or colorize it (NovelAI's Director tools; saved as a new file).
- **Matching** — compare every photo in one folder against a second folder and find each one's closest visual match by perceptual hash, resolution-independent (useful for tracking down an original, un-upscaled file). Review the matches, then copy the ones you want into a destination folder.
- **Detection** — run a YOLO (Ultralytics) model over a folder of photos, review the detected regions (toggle individual boxes or whole classes on/off), then pixelate the confirmed regions into an output folder. Originals are never modified.
- **Strip Metadata** — recursively remove EXIF and other metadata from every image in a folder and its subfolders, including NovelAI's prompt and settings — both the PNG text chunks and the "stealth" copy hidden in the alpha channel.
- **Upscale** — double an image's size with NovelAI's upscaler, for one file or every image in a folder. It costs 1 Anlas per image, so images over 1 megapixel (1024×1024) are skipped, and it asks for confirmation before every 10 images. Results are saved as new `name_upscaled.png` files.
- **Remix** — read the NovelAI prompts of every PNG in a folder, find the tags they share (a style block, or the same character in a character slot), swap them for new text, preview every new prompt, and send them to Generate. Generate makes them in batches of 25 with its own model, steps, vibes and output folder, optionally reusing each image's seed. Each image keeps its own size when it's free; a bigger one (an upscale, say) is scaled down to the nearest free size of the same shape.
- **Convert Prompt** — convert a prompt between NovelAI and Anima (ComfyUI) syntax: weights, `artist:` / `@` artist tags, escaped parentheses, and NovelAI's character prompts to and from Anima character lines (`1girl: ….`, or the character's name when two share a gender). Open or drop a PNG made with NovelAI or ComfyUI to read its prompt, or paste one in; **Send to Generate** fills the Generate tab after the usual import confirmation. Works offline.
- **Character Cards** — character prompt presets for NovelAI. Make a card from a NovelAI image (open or drop one): its character prompt is split into tags, with eye tags (colour, pupils) and hair tags (colour, style, length) sorted automatically using Danbooru's tag groups as listed on [tagexplorer](https://tagexplorer.github.io/), and you sort the rest into face, upper body and lower body. The prompt boxes get the same Danbooru tag suggestions as Generate. Cards are saved as small PNG thumbnails in a folder you choose. In Generate, **Load character card** fills a character with one and can leave out what won't be seen: facing away, closed eyes, upper body or lower body (each adds its tag too), or tick parts in or out by hand. A loaded character stays linked to its card, so when a prompt file adds a view tag to an image (facing away, from behind, closed eyes, upper body, lower body, head out of frame, POV), that image leaves out the card's tags for what won't be seen, and the next image gets them back. Works offline. Cards also keep a gender, labels (for pools and associations), tag swaps (`$c1 swap: boy$`) and an optional Precise Reference image. **Tag associations** ("when beach is present, add ocean, sand", or "when 1boy is in the prompt, put card Hiro in the first empty slot") are edited here. Cards, associations, saved prompts, the artist library and workflow plans all live in the card folder.

Each tab keeps its own state — switching between them doesn't lose an open folder or an in-progress operation.

## MCP server (let an AI assistant generate images)

`mcp-server/` builds `cutting-room-mcp.exe`, a local [MCP](https://modelcontextprotocol.io) server that lets an MCP client — Claude Code, Claude Desktop, or any other MCP-capable app on this PC — generate images through your NovelAI account and look at the results. It offers six tools:

- `novelai_account_status` — tier, Anlas, and Opus V5 quota (read-only).
- `novelai_generate_image` — generates one image and returns a preview; the full PNG is saved to the output folder, or to a folder the assistant names (`output_dir`, a full local path shown in the approval dialog). Optionally applies up to four vibes from vibe files you've already encoded (V4 and V4.5 models); a vibe that would need a paid encode is refused.
- `novelai_list_vibes` — lists the vibes in a vibe file and which models they're encoded for (read-only, nothing sent to NovelAI).
- `novelai_inpaint` — repaints part of an image of any size, the way NovelAI's Focused Inpainting does ("crop and stitch"): a crop of up to 1024×1024 (multiples of 64) is cut out, enlarged to about 1 megapixel, the masked part is inpainted, and that part is blended back into the full image with a soft edge. The mask is given as rectangles, ellipses, brush strokes or a mask image, snapped to NovelAI's 8-pixel grid. Only the crop is sent, so it's free on Opus at any image size. Saved as a new `name_inpainted.png`.
- `novelai_preview_inpaint` — shows the crop and mask on the image before inpainting (read-only, nothing sent to NovelAI).
- `novelai_upscale` — doubles one image's size with NovelAI's upscaler. It costs 1 Anlas every time, so the approval dialog leads with the cost and your balance; images over 1 megapixel are refused. Saved as a new `name_upscaled.png`.
- `novelai_emotion` / `novelai_colorize` — change a character's expression, or colorize, in one image (NovelAI's Director tools). Free on Opus: the image, or an `area` of a big one, is sent at no more than 1024×1024 worth of pixels and blended back. Saved as a new `name_emotion-happy.png` / `name_colorized.png`.

**Free requests run without asking; anything that costs Anlas needs your approval** in a Windows dialog showing the full request (including any vibe files) and the cost ("No" is the default button). That covers every upscale, any request on a non-Opus account, and V5 once the Opus quota is used up. The server waits 1 second before each request to NovelAI, on top of the 2-second minimum gap between requests. The server uses the same limits as the Generate tab — free sizes and step counts only, at least 2 seconds between requests, and a stop if NovelAI unexpectedly charges Anlas. It reads the token Cutting Room saved in Windows Credential Manager, so log in once in the Generate tab first; the token is never passed to the AI client.

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
npm test               # frontend unit tests (prompt engine, creep, pools)
```

Detection requires a Python environment with `ultralytics`, `torch`, and `opencv-python` installed, plus at least one YOLO `.pt` weights file — both are configured from within the Detection tab.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
