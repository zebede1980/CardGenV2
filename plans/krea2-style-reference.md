# Krea-2 Style Reference — PARKED (2026-10-09)

**Status:** tested locally, not built. Parked because the style guides we'd actually use are
almost all character portraits, and portraits leak their character into the result (see
Findings). Nothing for this is in the app; this doc is everything needed to pick it up again.

## What it is

Comfy's official template **"Krea-2 Int8: Image Style Reference"**
(`image_krea2_turbo_int8_image_style_reference`) with Ostris's style-reference LoRA
(<https://huggingface.co/ostris/krea2_turbo_style_reference>). You give a prompt for *what*
to draw and 1–2 reference images for *how it should look*. No trigger word.

## Already in place

- Krea-2 Turbo text-to-image is live as `local/krea-2-turbo` (commit `faf640d`), so the base
  model, text encoder and VAE are installed and working.
- The style LoRA is already downloaded:
  `J:\AI\WebForgeUI\webui\models\loras\krea2_style_reference.safetensors` (457MB). Delete it
  if this stays parked for good.
- No custom nodes needed. The Ostris model card says it needs `ComfyUI-Krea2-Ostris-Edit`, but
  Comfy's template does it with core nodes, and that is what was tested.

## The workflow (API format, tested)

The full graph is `styleGraph()` in [`krea2-style-reference/try-style.mjs`](krea2-style-reference/try-style.mjs).
It differs from plain Krea-2 like this:

| Node | Setting |
|---|---|
| `LoraLoaderModelOnly` | `krea2_style_reference.safetensors`, strength **1.0** (see Findings) |
| `ModelSamplingFlux` | max_shift 1.15, base_shift 0.5, width/height = output size |
| `TextEncodeQwenImageEditPlus` | clip + vae + prompt, references on `image1` / `image2` (`image3` exists, but the LoRA was trained on 1–2) |
| `FluxKontextMultiReferenceLatentMethod` | `index_timestep_zero` |
| `ConditioningZeroOut` | negative = zeroed positive |
| Sampler | `CFGGuider` cfg 1 → `SamplerCustomAdvanced`, `KSamplerSelect` euler, `BasicScheduler` simple, 8 steps |

The template's optional LLM prompt-rewrite branch (`TextGenerate`) was left off.
References went in at full size, and the encoder scales them itself.

Re-run the tests on the home PC (talks to `127.0.0.1:8188`):

```bash
node try-style.mjs refs                                   # make ink / pixel / nouveau references
node try-style.mjs style "<prompt>" ref-ink.png [ref2.png] # style-referenced generation
STRENGTH=0.75 node try-style.mjs style ...                # LoRA strength override
```

## Test results

All runs were at 896×1152 on the RTX 4080 Super 16GB, direct to ComfyUI (not through OCI).

**1. Non-character style references: works very well**
([styles-vs-dwarf.jpg](krea2-style-reference/styles-vs-dwarf.jpg)). Ink-wash landscape,
pixel-art castle and art-nouveau poster references, then a dwarf blacksmith prompt against
each one. The style transferred strongly, and none of the references' content (boats, castle,
lily woman) leaked in. Quirks:
- The ink style adds fake calligraphy.
- The reference dominates the scene, so the prompt's "at his forge" background was mostly lost.

**2. Two references blend coherently**
([portrait-leak-and-blend.jpg](krea2-style-reference/portrait-leak-and-blend.jpg), right):
ink + nouveau → wizard.

**3. Portrait as reference: the character leaks** (same sheet, left three). Using a Krea elf
ranger portrait as the style for an orc warlord and a halfling bard, both came out with the
elf's pointed ears, silver braids and green hooded tunic. **This is why it's parked.**

**4. Lower LoRA strength makes the leak worse**
([lora-strength.jpg](krea2-style-reference/lora-strength.jpg)): orc at 1.0 / 0.75 / 0.5.
- At 0.75 the elf's hood comes back.
- At 0.5 the orc becomes a female elf with tusks.

The reference image always conditions the model; the LoRA is what makes it read that image as
style rather than content. So the strength stays fixed at 1.0, with no slider.

**Timings:**
- Warm: 15–20s with one reference, ~27s with two.
- First run (LoRA load): ~50s.
- One unexplained two-reference run took 127s; the identical rerun took 27s.

## Ideas if we pick it up again (all untested)

1. **Vision-model style description instead of a style LoRA.** This is the most promising for
   portraits. Have a vision LLM describe only the *style* of the portrait (medium, palette,
   brushwork, lighting) as text, and append that to the prompt for any model. Character
   features never reach the image model, so nothing can leak. The app already sends reference
   images to a vision model (`prepareReferenceImageForVision`, "Reference image details" in
   the Character Generator).
2. **Crop the reference to a non-character region:** background, or a patch of clothing or
   texture. That keeps the brushwork and palette without the face, ears or hair.
3. **Explicit prompt override:** state the conflicting traits outright ("bald, green skin, red
   leather armour, no hood") and see whether the prompt beats the leak.
4. **Style plates:** generate a character-free scene in the wanted style once, and use that as
   the reference for a whole card set. This is what worked in test 1, but it doesn't help with
   existing portraits.
5. Watch for a newer Ostris LoRA, or try the `ComfyUI-Krea2-Ostris-Edit` custom node's own
   template, which may behave differently from Comfy's core-node version.

## Design sketched before parking

In case the leak gets solved:
- **Proxy:** a `local/krea-2-style` entry in `LOCAL_COMFY_MODELS` (`proxy/server.js`). The
  request carries `style_images: [dataUri, dataUri?]`, each uploaded like the edit source
  image.
- **Settings:** a fifth capability, 🎨 Style, so only style models show the slots.
- **Stage 1:** 1–2 "Style reference" slots in the Playground's Generate tab, filled by upload,
  paste, 📚 From Library, or the current image.
- **Stage 2:** named style sets that store **Playground Library image IDs, not images**, to
  keep the server-synced config small, plus a "Style set" dropdown in the Character Generator
  for consistent card sets.
- Keep the Combine tab separate: it means "merge these images" and needs 2+, whereas style
  reference means "draw something new in this style" and works with one.
