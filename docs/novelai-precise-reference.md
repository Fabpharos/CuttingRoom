# NovelAI Precise Reference: API guide

How to send Precise Reference (character / style / outfit reference images) to NovelAI's image API, for V4.5 and V5. NovelAI's API spec (`https://image.novelai.net/docs/doc.json`) and its release posts don't give these details. Everything marked **confirmed** was read from the metadata NovelAI writes into images made on novelai.net, in November 2026. Cutting Room's implementation is in `crates/novelai-core/src/reference.rs`.

## Where the fields go

Precise Reference is part of an ordinary generation request (`POST https://image.novelai.net/ai/generate-image`, `action: "generate"`). All fields below go in `parameters`. Each one is a list with one entry per reference, all in the same order.

| Field | Value per reference |
|---|---|
| `director_reference_images` | The reference image: a PNG, base64, padded to a fixed canvas (see below) |
| `director_reference_descriptions` | `{"caption": {"base_caption": <type>, "char_captions": []}, "use_coords": false, "use_order": false, "legacy_uc": false}` |
| `director_reference_information_extracted` | `1` |
| `director_reference_strengths` | Strength |
| `director_reference_secondary_strengths` | V4.5: `1 - fidelity`. V5: `0` |

Images record exactly those names (**confirmed**, V4.5 and V5). NovelAI's API spec spells the strengths `director_reference_strength_values` and `director_reference_secondary_strength_values`; Cutting Room sends both spellings with the same values.

## The type (`base_caption`)

| Reference type in NovelAI's UI | V4.5 | V5 |
|---|---|---|
| Character | `character` | `character` (**confirmed**) |
| Style | `style` | `style` (**confirmed**) |
| Character & Style | `character&style` | `character&style` (**confirmed**) |
| Outfit | (no such type) | `costume` (**confirmed**; not `outfit`) |

On V5, Character and Character & Style references also have a **Prefer same outfit** checkbox (V4.5 doesn't):

| Type | Unticked | Ticked |
|---|---|---|
| Character | `character` (**confirmed**) | `character_mainoutfit` (**confirmed**) |
| Character & Style | `character&style_anyoutfit` (**confirmed**) | `character&style` (**confirmed**) |

The two go opposite ways: Character gets a suffix when it's ticked, Character & Style when it isn't. So plain `character&style` on V5 means "prefer the same outfit".

Several references of the same or different types can go in one request: a Character and a Style reference as two separate entries is **confirmed** on V5.

## Strength and fidelity

- **V4.5:** strength 0–1 and fidelity 0–1. The site sends the secondary strength as `1 - fidelity`. **Confirmed:** strength 0.8 and fidelity 0.3 were recorded as `0.8` and `0.7`.
- **V5:** strength 0–5 (NovelAI's release post). V5 has no fidelity slider, and every V5 sample records a secondary strength of `0` (**confirmed**). Strength is recorded as sent: 1.2 and 0.8 (**confirmed**).

## The reference image

Cutting Room sends each image padded, not cropped, to one of three canvases picked by its shape, as NovelAI's web client does: 1024×1536 for portrait (width/height below 0.85), 1536×1024 for landscape (above 1.18), otherwise 1472×1472. It's scaled to fit, centred on black, and re-encoded as a plain PNG with no metadata. This was taken from the web client for V4.5 and is used unchanged for V5. It hasn't been checked against a request sent from Cutting Room: the findings above all come from images made on novelai.net.

## Models

- **V4.5:** `nai-diffusion-4-5-full`, `nai-diffusion-4-5-curated`. Can't be combined with Vibe Transfer.
- **V5:** `nai-diffusion-5-full`, `nai-diffusion-5-curated` (and Cutting Room also allows `nai-diffusion-5-full-medium`, which is untested). V5 has no Vibe Transfer. NovelAI says inpainting with Precise References isn't supported yet.
- V5 Full images made with a reference record the metadata Source `NovelAI Diffusion V5 81E2A1BD` (**confirmed**), not V5 Full's usual hash (`0ADF9AB7` in the same sample set). Map `81E2A1BD` to `nai-diffusion-5-full` when reading settings back from an image.
- Images made with a reference also record `"pure_t2i": false`; images without one don't record the key at all. Cutting Room doesn't send it.

## Cost

5 Anlas per reference per image, on V4.5 and V5 alike (NovelAI's release posts). It's never free, even on Opus. NovelAI's V5 post says Opus's free weekly V5 images are the ones made without Vibe Transfer or Precise Reference. Cutting Room shows the price, asks first, and stops a batch if an image costs more than `5 × references`. NovelAI's post says you can add "as many references as you like". Cutting Room caps it at 6 per image because each one costs more.

## Example (V5, three references)

```json
"parameters": {
  "director_reference_images": ["<png base64>", "<png base64>", "<png base64>"],
  "director_reference_descriptions": [
    {"caption": {"base_caption": "character_mainoutfit", "char_captions": []}, "use_coords": false, "use_order": false, "legacy_uc": false},
    {"caption": {"base_caption": "costume", "char_captions": []}, "use_coords": false, "use_order": false, "legacy_uc": false},
    {"caption": {"base_caption": "style", "char_captions": []}, "use_coords": false, "use_order": false, "legacy_uc": false}
  ],
  "director_reference_information_extracted": [1, 1, 1],
  "director_reference_strengths": [1.2, 1.0, 2.5],
  "director_reference_secondary_strengths": [0, 0, 0]
}
```

This costs 15 Anlas per image.
