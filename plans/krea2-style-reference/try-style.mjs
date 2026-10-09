// Style-reference experiment against local ComfyUI.
//   node try-style.mjs refs                -> make reference images with plain Krea-2
//   node try-style.mjs style <prompt> <ref.png> [ref2.png]  -> style-referenced generation
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const base = "http://127.0.0.1:8188";
const here = (f) => new URL(f, import.meta.url);
const OUT = "56";

async function run(graph, outName) {
  const t0 = Date.now();
  const submit = await fetch(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) });
  const text = await submit.text();
  if (!submit.ok) throw new Error(`rejected ${submit.status}: ${text.slice(0, 1500)}`);
  const { prompt_id } = JSON.parse(text);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let entry;
    try { entry = (await (await fetch(`${base}/history/${prompt_id}`)).json())[prompt_id]; } catch { continue; }
    if (!entry || entry.status?.completed === undefined) continue;
    if (entry.status.status_str !== "success") throw new Error(JSON.stringify(entry.status.messages.find(([t]) => t === "execution_error")?.[1]?.exception_message));
    const img = entry.outputs[OUT].images[0];
    const view = await fetch(`${base}/view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type })}`);
    writeFileSync(here(outName), Buffer.from(await view.arrayBuffer()));
    console.log(`OK ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outName}`);
    return;
  }
}

async function upload(file) {
  const form = new FormData();
  form.append("image", new Blob([readFileSync(here(file))], { type: "image/png" }), `style_${basename(file)}`);
  form.append("subfolder", "cardgen");
  form.append("overwrite", "true");
  const res = await (await fetch(`${base}/upload/image`, { method: "POST", body: form })).json();
  return `${res.subfolder}/${res.name}`;
}

const loaders = {
  10: { class_type: "UNETLoader", inputs: { unet_name: "krea2_turbo_int8_convrot.safetensors", weight_dtype: "default" } },
  11: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2", device: "default" } },
  12: { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
};

function plainGraph(prompt, seed, width = 1024, height = 1024) {
  return {
    ...loaders,
    6: { class_type: "CLIPTextEncode", inputs: { clip: ["11", 0], text: prompt } },
    13: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } },
    5: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    3: { class_type: "KSampler", inputs: { model: ["10", 0], positive: ["6", 0], negative: ["13", 0], latent_image: ["5", 0], seed, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    8: { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["12", 0] } },
    [OUT]: { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "cardgen/styletest" } },
  };
}

// Mirrors Comfy's "Krea-2 Int8: Image Style Reference" template, prompt-rewrite branch off.
function styleGraph(prompt, refs, seed, width = 896, height = 1152) {
  const graph = {
    ...loaders,
    15: { class_type: "LoraLoaderModelOnly", inputs: { model: ["10", 0], lora_name: "krea2_style_reference.safetensors", strength_model: Number(process.env.STRENGTH || 1) } },
    64: { class_type: "ModelSamplingFlux", inputs: { model: ["15", 0], max_shift: 1.15, base_shift: 0.5, width, height } },
    52: { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["11", 0], vae: ["12", 0], prompt } },
    53: { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["52", 0], reference_latents_method: "index_timestep_zero" } },
    13: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["53", 0] } },
    57: { class_type: "CFGGuider", inputs: { model: ["64", 0], positive: ["53", 0], negative: ["13", 0], cfg: 1 } },
    63: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    59: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    60: { class_type: "BasicScheduler", inputs: { model: ["64", 0], scheduler: "simple", steps: 8, denoise: 1 } },
    61: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    58: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["63", 0], guider: ["57", 0], sampler: ["59", 0], sigmas: ["60", 0], latent_image: ["61", 0] } },
    62: { class_type: "VAEDecode", inputs: { samples: ["58", 0], vae: ["12", 0] } },
    [OUT]: { class_type: "SaveImage", inputs: { images: ["62", 0], filename_prefix: "cardgen/styletest" } },
  };
  refs.forEach((name, i) => {
    graph[70 + i] = { class_type: "LoadImage", inputs: { image: name } };
    graph[52].inputs[`image${i + 1}`] = [String(70 + i), 0];
  });
  return graph;
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "refs") {
  const refs = {
    "ref-ink.png": "Monochrome Japanese ink wash painting of a lone fishing boat on a misty lake with distant mountains, sumi-e brushstrokes, rice paper texture",
    "ref-pixel.png": "16-bit pixel art of a castle on a hill at sunset, limited palette, crisp pixels, retro video game screenshot",
    "ref-nouveau.png": "Art nouveau poster of a woman among lilies, Alphonse Mucha style, flowing ornamental borders, flat muted gold and teal colours, lithograph print",
  };
  for (const [file, prompt] of Object.entries(refs)) await run(plainGraph(prompt, 777), file);
} else if (mode === "style") {
  const [prompt, ...refFiles] = args;
  const names = [];
  for (const f of refFiles) names.push(await upload(f));
  const out = `out-${refFiles.map((f) => basename(f, ".png").replace("ref-", "")).join("+")}.png`;
  await run(styleGraph(prompt, names, 4242), out);
}
