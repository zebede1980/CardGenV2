// Image generation and prompt building methods — extends APIHandler via prototype

// Default width/height pairs used by Flux-family and most other cloud models.
const DEFAULT_RATIO_MAP = {
  "1:1": { width: 1024, height: 1024 },
  "9:16": { width: 768, height: 1344 },
  "16:9": { width: 1344, height: 768 },
  "3:4": { width: 896, height: 1152 },
  "4:3": { width: 1152, height: 896 },
};

// Seedream (ByteDance, via NanoGPT) enforces its own fixed enum of resolution
// strings plus a ~3.7MP minimum — DEFAULT_RATIO_MAP's dims are below that
// minimum, so sending them silently falls back to a square output instead
// of erroring. Values below are pulled from NanoGPT's seedream-v5.0-lite
// supported_parameters.resolutions list.
const SEEDREAM_RATIO_MAP = {
  "1:1": { width: 2048, height: 2048 },
  "9:16": { width: 1440, height: 2560 },
  "16:9": { width: 2560, height: 1440 },
  "3:4": { width: 2048, height: 3072 },
  "4:3": { width: 3072, height: 2048 },
};

function getRatioDims(model, ratio) {
  const map = /seedream/i.test(model || "") ? SEEDREAM_RATIO_MAP : DEFAULT_RATIO_MAP;
  return map[ratio];
}

// How each hosted model takes its size, from nano-gpt's model list via the
// proxy's /api/image/catalog: { id: { tiers, sizes: [[w,h]], aspectRatios,
// customSize } }. Null until loaded, and if it couldn't be; everything below
// then falls back to the fixed ratio maps above.
let imageCatalog = null;
let imageCatalogPromise = null;

// Ids added by hand can be a short alias: "nano-banana-2.1" is listed as
// "google/gemini-nano-banana-2.1". A unique match on a name boundary counts.
function findImageCatalogEntry(model) {
  if (!imageCatalog || !model || model.startsWith("local/")) return null;
  if (imageCatalog[model]) return imageCatalog[model];
  const matches = Object.keys(imageCatalog).filter(id =>
    id.length > model.length && id.endsWith(model) && /[/-]$/.test(id.slice(0, -model.length)));
  return matches.length === 1 ? imageCatalog[matches[0]] : null;
}

// Some models (Nano Banana, qwen-image-3-pro) take a resolution tier
// ("1k"/"2k") plus a named aspect ratio, and reject any pixel size with a 400
// ("Nano Banana 2.1 supports 1K or 2K resolution"). Leaving the tier unset
// uses the model's own default. The name check covers Nano Banana when the
// catalogue is unavailable or doesn't know the id.
function usesResolutionTiers(model) {
  const entry = findImageCatalogEntry(model);
  if (entry) return entry.tiers.length > 0 && entry.sizes.length === 0;
  return /nano-banana/i.test(model || "");
}

// For models that accept only a fixed list of sizes (flux-2 has no 4:3 at
// all): the listed size nearest the requested shape, then nearest the size we
// would otherwise have asked for.
function closestListedSize(sizes, ratio, target) {
  const [rw, rh] = ratio.split(":").map(Number);
  if (!(rw > 0 && rh > 0)) return null;
  const wantShape = Math.log(rw / rh);
  const wantArea = target ? target.width * target.height : 1024 * 1024;
  let best = null;
  let bestScore = Infinity;
  for (const [w, h] of sizes) {
    // Shape outweighs size: a wrong shape is visible, a smaller image is not.
    const score = Math.abs(Math.log(w / h) - wantShape) * 10 + Math.abs(Math.log((w * h) / wantArea));
    if (score < bestScore) {
      bestScore = score;
      best = { width: w, height: h };
    }
  }
  return best;
}

// Sets whichever size fields the model understands for the chosen ratio.
// Local models and any-size models get our own pixel dims, as before.
function applyImageRatio(data, model, ratio) {
  if (!ratio) return;
  data.aspect_ratio = ratio;
  if (usesResolutionTiers(model)) return;
  const entry = findImageCatalogEntry(model);
  const fallback = getRatioDims(model, ratio);
  const dims = entry && !entry.customSize && entry.sizes.length
    ? closestListedSize(entry.sizes, ratio, fallback) || fallback
    : fallback;
  if (dims) {
    data.width = dims.width;
    data.height = dims.height;
    data.size = `${dims.width}x${dims.height}`;
  }
}

// The tier to ask for when enhancing: 2k if offered, else the largest listed.
// Null for a model with no tiers to choose from ("auto" only): send none.
function upscaleTierFor(model) {
  const entry = findImageCatalogEntry(model);
  if (!entry) return "2k";
  const tiers = entry.tiers.filter(t => t !== "auto");
  if (!tiers.length) return null;
  if (tiers.includes("2k")) return "2k";
  return tiers.slice().sort((a, b) => parseFloat(a) - parseFloat(b)).pop();
}

Object.assign(APIHandler.prototype, {

  // Loaded once and shared; awaited (briefly) before any request that sets a
  // size. A failure is not remembered, so the next request tries again.
  loadImageCatalog() {
    if (imageCatalog) return Promise.resolve(imageCatalog);
    if (!imageCatalogPromise) {
      imageCatalogPromise = (async () => {
        try {
          const res = await (window.authFetch || fetch)("/api/image/catalog", { headers: this._authHeaders() });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          if (body?.models && Object.keys(body.models).length) imageCatalog = body.models;
        } catch (err) {
          console.warn("[images] model catalogue unavailable, using default sizes:", err?.message || err);
        } finally {
          imageCatalogPromise = null;
        }
        return imageCatalog;
      })();
    }
    // Never hold up a generation for long over this.
    return Promise.race([imageCatalogPromise, new Promise(r => setTimeout(() => r(imageCatalog), 5000))]);
  },

  async generateImage(
    characterDescription,
    characterName,
    customPrompt = null,
    modelOverride = null,
    cardType = "single",
    styleOverride = undefined,
    guidance = "",
    moodOverride = undefined
  ) {
    const model = modelOverride || this.config.get("api.image.model");
    const modelSettings = this.config.get("api.image.modelSettings") || {};
    const settings = modelSettings[model] || {};
    const promptLengthPref = settings.promptLengthPref || "detailed";

    let imagePrompt;
    if (customPrompt) {
      imagePrompt = promptLengthPref === "short" ? await this.truncateImagePrompt(customPrompt) : customPrompt.trim();
    } else {
      console.log("=== GENERATING IMAGE PROMPT VIA TEXT API ===");
      console.log("Character name:", characterName);
      console.log("Character description length:", characterDescription?.length || 0);
      if (guidance) console.log("Guidance:", guidance);
      try {
        imagePrompt = await this.generateImagePrompt(characterDescription, characterName, cardType, guidance, styleOverride, moodOverride);
      } catch (error) {
        console.error("Failed to generate image prompt:", error);
        throw new Error(`Failed to generate image prompt: ${error.message}`);
      }
    }

    if (!imagePrompt || typeof imagePrompt !== "string" || imagePrompt.trim().length === 0) {
      console.error("=== IMAGE PROMPT VALIDATION FAILED ===");
      throw new Error(
        "Image prompt is empty or invalid. Cannot generate image without a prompt. " +
          "This usually means the text API failed to generate a prompt description.",
      );
    }

    this.lastGeneratedImagePrompt = imagePrompt;

    // On the Style Preset path, prose and tag prompts get the style and mood
    // bookended on here, to enforce them; the writer starts them at the
    // subject so the opening joins up. Fragment prompts and prompts written to
    // a Look carry their own style, and a bookend on top used to read as
    // "…illustration of A 2.5D anime image of a portrait of…" plus a pile of
    // SD tags.
    let finalApiPrompt = imagePrompt;
    const lookActive = styleOverride === undefined && moodOverride === undefined && !!this.getActiveLook();
    const writtenAs = this._promptFormats?.get(imagePrompt.trim()) || this.imagePromptPrefs(model).format;
    const naturalLanguage = lookActive || writtenAs === "fragments";

    const activeStyle = styleOverride !== undefined ? styleOverride : this.config.get("api.image.style");
    const activeMood = moodOverride !== undefined ? moodOverride : this.config.get("api.image.mood");

    if (naturalLanguage) {
      // Nothing to add.
    } else if (activeStyle && activeStyle !== "custom") {
      const styleTags = this.getImageStyleTags(activeStyle);
      if (styleTags && (styleTags.prefix || styleTags.suffix)) {
        finalApiPrompt = `${styleTags.prefix ? styleTags.prefix + " " : ""}${finalApiPrompt}${styleTags.suffix ? ", " + styleTags.suffix : ""}`;
      }
    } else if (activeStyle === "custom") {
      const customStyleText = this.config.get("api.image.customStyleText");
      if (customStyleText && customStyleText.trim()) {
        finalApiPrompt = `${finalApiPrompt}, in the style of ${customStyleText.trim()}, masterpiece, best quality, highly detailed`;
      }
    }

    if (!naturalLanguage && activeMood && activeMood.trim()) {
      const formattedMood = activeMood.replace(/-/g, " ");
      finalApiPrompt = `${finalApiPrompt}, ${formattedMood} mood, ${formattedMood} atmosphere, evocative lighting`;
    }

    const IMAGE_PROMPT_MAX = promptLengthPref === "short" ? 1000 : 10000;
    
    // Safety trim
    if (promptLengthPref === "short" && finalApiPrompt.length > IMAGE_PROMPT_MAX) {
      const trimmed = finalApiPrompt.substring(0, IMAGE_PROMPT_MAX);
      const lastPeriod = trimmed.lastIndexOf(".");
      const lastComma = trimmed.lastIndexOf(",");
      const cutPoint = lastPeriod > IMAGE_PROMPT_MAX * 0.7 ? lastPeriod + 1 : lastComma > IMAGE_PROMPT_MAX * 0.7 ? lastComma : IMAGE_PROMPT_MAX;
      finalApiPrompt = trimmed.substring(0, cutPoint).trim();
    }

    console.log("=== SENDING TO IMAGE API ===");
    console.log("Using image model:", model);
    console.log("Using custom prompt:", !!customPrompt);
    console.log("Image prompt length:", finalApiPrompt.length);
    console.log("Full image prompt being sent:");
    console.log(finalApiPrompt);
    console.log("=== END PROMPT ===");

    const data = {
      model: model,
      prompt: finalApiPrompt,
      n: 1,
      response_format: "url",
      seed: Math.floor(Math.random() * 2147483647),
    };

    await this.loadImageCatalog();
    const imageSize = this.config.get("api.image.size");
    const imageAspectRatio = this.config.get("api.image.aspectRatio");
    const imageSteps = settings.steps;
    const imageCfgScale = settings.cfgScale;

    if (imageAspectRatio && imageAspectRatio.trim() !== "") {
      applyImageRatio(data, model, imageAspectRatio.trim());
    } else if (imageSize && imageSize.trim() !== "" && !usesResolutionTiers(model)) {
      data.size = imageSize.trim();
    }
    
    if (imageSteps && !isNaN(parseInt(imageSteps))) {
      data.steps = parseInt(imageSteps);
    }
    if (imageCfgScale && !isNaN(parseFloat(imageCfgScale))) {
      data.cfg_scale = parseFloat(imageCfgScale);
    }

    // Same reasoning as editImage(): a phone locking mid-generation must not
    // strand a paid-for image with nowhere to land.
    data.resumable = true;
    data.__jobLabel = "Character image";

    const response = await this.makeRequest("/api/image/generations", data, true);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image API error response:", errorText);
      let errorData;
      try { errorData = JSON.parse(errorText); } catch (e) {
        throw new Error(`Image API Error (${response.status}): ${errorText}`);
      }
      const errorMessage = errorData.error?.message || errorData.message || errorData.error || "Unknown error";
      throw new Error(`Image API Error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();

    if (result.error) {
      console.error("Image API returned error object:", result.error);
      throw new Error(`Image API Error: ${result.error.message || result.error.details || result.error}`);
    }

    if (result.data && result.data.length > 0) return result.data[0].url;
    if (result.image) return result.image;
    if (result.url) return result.url;

    console.error("Unexpected image API response format. Full response:", result);
    throw new Error("Unexpected image API response format: " + JSON.stringify(result));
  },

  // ── Text-to-Image Generation (Playground) ───────────────────────────────────
  // A deliberately lightweight sibling of generateImage() above: that method
  // is built for character cards (LLM-authored prompt, style/mood tag
  // injection, per-model prompt-length prefs). This one just sends whatever
  // the user typed straight to the model via the same /api/image/generations
  // proxy route, for the Playground's "create from nothing" tab.
  async generateImageFromPrompt({ prompt, model, aspectRatio }) {
    const trimmedPrompt = (prompt || "").trim();
    if (!trimmedPrompt) throw new Error("A prompt is required to generate an image.");

    const generateModel = model || this.config.get("api.image.generateModel");
    if (!generateModel) throw new Error("Choose a model first.");

    const data = {
      model: generateModel,
      prompt: trimmedPrompt,
      n: 1,
      response_format: "url",
      seed: Math.floor(Math.random() * 2147483647),
    };

    await this.loadImageCatalog();
    applyImageRatio(data, generateModel, aspectRatio || this.config.get("api.image.aspectRatio"));

    console.log("=== SENDING PLAYGROUND GENERATE REQUEST ===");
    console.log("Generate model:", generateModel);

    // Same reasoning as editImage(): a phone locking mid-generation must not
    // strand a paid-for image with nowhere to land.
    data.resumable = true;
    data.__jobLabel = "Playground image";

    const startedAt = performance.now();
    const response = await this.makeRequest("/api/image/generations", data, true);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image Generate API error response:", errorText);
      let errorData;
      try { errorData = JSON.parse(errorText); } catch (e) {
        throw new Error(`Image Generate API Error (${response.status}): ${errorText}`);
      }
      const errorMessage = errorData.error?.message || errorData.message || errorData.error || "Unknown error";
      throw new Error(`Image Generate API Error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();
    if (result.error) {
      console.error("Image Generate API returned error object:", result.error);
      throw new Error(`Image Generate API Error: ${result.error.message || result.error.details || result.error}`);
    }

    const resultUrl = (result.data && result.data.length > 0 && result.data[0].url) || result.image || result.url;
    if (!resultUrl) {
      console.error("Unexpected image generate API response format. Full response:", result);
      throw new Error("Unexpected image generate API response format: " + JSON.stringify(result));
    }
    // Only successful runs are timed — a call that errored out after two
    // seconds says nothing about how long the model takes when it works.
    recordImageModelRun(generateModel, performance.now() - startedAt, this.config);
    return resultUrl;
  },

  // ── Upscale / enhance ───────────────────────────────────────────────────────
  // Deliberately its own method rather than a flag on editImage(): the prompt is
  // fixed (the whole point is to change nothing but the resolution), and it asks
  // for explicit larger dimensions, which no other call does.
  //
  // Whether this produces a genuine upscale depends entirely on the model —
  // nano-gpt has no documented dedicated upscaler, so this drives whichever
  // image-to-image model the user marked ⬆️ Enhance. A weak model will re-imagine
  // detail rather than recover it; that is a property of the model, not a bug
  // here, which is why the choice is exposed rather than hardcoded.
  async upscaleImage({ imageBase64, model, scale = 2, instruction = "" }) {
    if (!imageBase64) throw new Error("An image is required to upscale.");

    const upscaleModel = model || this.config.get("api.image.upscaleModel") || this.config.get("api.image.editModel");
    if (!upscaleModel) throw new Error("Choose a model to enhance with first.");

    // Measured from the source rather than assumed, so the aspect ratio is
    // preserved whatever was loaded.
    const { width, height } = await this._measureImageDataUrl(imageBase64);
    const factor = Math.max(1, Math.min(4, Number(scale) || 2));
    // Capped because providers reject absurd dimensions outright, and a request
    // that fails on size wastes the call.
    const targetWidth = Math.min(4096, Math.round(width * factor));
    const targetHeight = Math.min(4096, Math.round(height * factor));

    const basePrompt =
      "Upscale this image to a higher resolution. Increase fine detail and sharpness, " +
      "remove compression artefacts, noise and blur. Keep the composition, subject, framing, " +
      "colours and art style exactly as they are — do not add, remove or reinterpret anything.";

    const data = {
      model: upscaleModel,
      prompt: instruction.trim() ? `${basePrompt} ${instruction.trim()}` : basePrompt,
      image: imageBase64,
      n: 1,
      response_format: "url",
      width: targetWidth,
      height: targetHeight,
      size: `${targetWidth}x${targetHeight}`,
      seed: Math.floor(Math.random() * 2147483647),
      resumable: true,
      __jobLabel: "Image enhance",
    };
    // Tier models reject pixel sizes; 2k is the step up from their 1k default.
    await this.loadImageCatalog();
    if (usesResolutionTiers(upscaleModel)) {
      delete data.width;
      delete data.height;
      delete data.size;
      const tier = upscaleTierFor(upscaleModel);
      if (tier) data.resolution = tier;
    }

    console.log("=== SENDING IMAGE UPSCALE REQUEST ===");
    console.log("Upscale model:", upscaleModel, `${width}x${height} -> ${targetWidth}x${targetHeight}`);

    const startedAt = performance.now();
    const response = await this.makeRequest("/api/image/generations", data, true);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image Upscale API error response:", errorText);
      let errorMessage = errorText;
      try {
        const errData = JSON.parse(errorText);
        errorMessage = errData.error?.message || errData.error?.details || errData.message || errorText;
      } catch (e) { /* fall back to the raw body */ }
      throw new Error(`Image Enhance API Error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();
    if (result.error) {
      throw new Error(`Image Enhance API Error: ${result.error.message || result.error.details || result.error}`);
    }

    const resultUrl = (result.data && result.data.length > 0 && result.data[0].url) || result.image || result.url;
    if (!resultUrl) {
      console.error("Unexpected image enhance API response format. Full response:", result);
      throw new Error("Unexpected response format from the Image Enhance API: " + JSON.stringify(result).slice(0, 300));
    }

    recordImageModelRun(upscaleModel, performance.now() - startedAt, this.config);
    return resultUrl;
  },

  /** Natural pixel dimensions of a data: URL, for scaling decisions. */
  _measureImageDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      img.onerror = () => reject(new Error("Could not read the image dimensions"));
      img.src = dataUrl;
    });
  },

  // ── Image-to-Image Editing ────────────────────────────────────────────────
  // Sends an existing image + a plain-language instruction to an image-to-image
  // model (e.g. flux-2-pro-image-to-image, flux-kontext) via the same
  // /api/image/generations proxy route used for text-to-image — these models
  // are called identically, just with an extra `image` field carrying the
  // source as a base64 data URI.
  async editImage({ imageBase64, instruction, model, aspectRatio }) {
    if (!imageBase64) throw new Error("An image is required to edit.");
    const trimmedInstruction = (instruction || "").trim();
    if (!trimmedInstruction) throw new Error("An edit instruction is required.");

    const editModel = model || this.config.get("api.image.editModel") || "flux-2-pro-image-to-image";

    const data = {
      model: editModel,
      prompt: trimmedInstruction,
      image: imageBase64,
      n: 1,
      response_format: "url",
      seed: Math.floor(Math.random() * 2147483647),
    };

    await this.loadImageCatalog();
    applyImageRatio(data, editModel, aspectRatio || this.config.get("api.image.aspectRatio"));

    console.log("=== SENDING IMAGE EDIT REQUEST ===");
    console.log("Edit model:", editModel);
    console.log("Instruction:", trimmedInstruction);

    // Edits routinely run past a minute; opt into server-side buffering so a
    // phone locking or backgrounding mid-edit doesn't strand the result —
    // nano-gpt finishes and saves the image on its side regardless, this is
    // what lets a returning client collect it instead of losing it.
    data.resumable = true;
    data.__jobLabel = "Image edit";
    const startedAt = performance.now();
    const response = await this.makeRequest("/api/image/generations", data, true);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image Edit API error response:", errorText);
      let errorData;
      try { errorData = JSON.parse(errorText); } catch (e) {
        throw new Error(`Image Edit API Error (${response.status}): ${errorText}`);
      }
      const errorMessage = errorData.error?.message || errorData.message || errorData.error || "Unknown error";
      throw new Error(`Image Edit API Error (${response.status}): ${errorMessage}`);
    }

    const result = await response.json();

    if (result.error) {
      console.error("Image Edit API returned error object:", result.error);
      throw new Error(`Image Edit API Error: ${result.error.message || result.error.details || result.error}`);
    }

    const resultUrl = (result.data && result.data.length > 0 && result.data[0].url) || result.image || result.url;
    if (!resultUrl) {
      console.error("Unexpected image edit API response format. Full response:", result);
      throw new Error("Unexpected image edit API response format: " + JSON.stringify(result));
    }

    // Some image-to-image models (observed with flux-kontext) silently return
    // a solid black image instead of an error when their safety filter rejects
    // the source image — same HTTP 200, same response shape. Catch that here
    // so the caller gets a real error instead of a blank picture.
    const blocked = await this.isLikelySafetyBlockedImage(resultUrl);
    if (blocked) {
      throw new Error(
        "The edit model returned a blank image — this usually means its content-safety filter rejected the source image. " +
        "Try a different Image Edit Model in Settings (e.g. flux-2-max-image-to-image), or a less explicit source image."
      );
    }

    // Recorded after the safety-blank check, so a rejected edit doesn't count
    // as a fast successful run and drag the model's average down.
    recordImageModelRun(editModel, performance.now() - startedAt, this.config);
    return resultUrl;
  },

  // Loads `imageUrl` and checks whether it's a suspiciously uniform (near
  // solid-color) image — the signature of a silent safety-filter block rather
  // than a real generation. Fetches via the proxy first so the canvas read
  // below doesn't taint on a cross-origin image.
  async isLikelySafetyBlockedImage(imageUrl) {
    try {
      const proxyUrl = imageUrl.startsWith("data:") || imageUrl.startsWith("blob:")
        ? imageUrl
        : `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
      const response = await (window.authFetch || fetch)(proxyUrl);
      if (!response.ok) return false;
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      try {
        const variance = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            try {
              const sampleSize = 32;
              const canvas = document.createElement("canvas");
              canvas.width = sampleSize;
              canvas.height = sampleSize;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
              const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);
              let sum = 0;
              let sumSq = 0;
              const n = sampleSize * sampleSize;
              for (let i = 0; i < data.length; i += 4) {
                const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
                sum += luminance;
                sumSq += luminance * luminance;
              }
              const mean = sum / n;
              resolve(sumSq / n - mean * mean);
            } catch (e) {
              reject(e);
            }
          };
          img.onerror = () => reject(new Error("Failed to load image for blank-check"));
          img.src = objectUrl;
        });
        // A real photo/illustration has substantial pixel variance; a
        // solid-color safety-block image has variance ~0.
        return variance < 4;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (e) {
      console.warn("Blank-image safety check failed, assuming image is fine:", e);
      return false;
    }
  },

  // Character Gen's way in to writeImagePrompt: the card is the subject. The
  // look is Character Gen's active Look when one is set, otherwise the Style
  // Preset and Mood as before. An explicit style or mood (Gen 4 picks one per
  // variation) always wins over the Look. `modelOverride` writes for that
  // model's preferences instead of the active model's — Compare Models drafts
  // one per model.
  async generateImagePrompt(characterDescription, characterName, cardType = "single", guidance = "", styleOverride = undefined, moodOverride = undefined, modelOverride = null) {
    if (!characterDescription || !characterName) {
      throw new Error("Character description and name are required to generate an image prompt");
    }

    const imageModel = modelOverride || this.config.get("api.image.model");
    const explicitStyle = styleOverride !== undefined || moodOverride !== undefined;
    const look = explicitStyle ? null : this.getActiveLook();
    const prefs = this.imagePromptPrefs(imageModel);

    const prompt = await this.writeImagePrompt({
      subject: { kind: "card", name: characterName, description: characterDescription, cardType, direction: guidance },
      look,
      legacyStyle: look ? null : {
        style: styleOverride !== undefined ? styleOverride : this.config.get("api.image.style"),
        mood: moodOverride !== undefined ? moodOverride : this.config.get("api.image.mood"),
      },
      format: prefs.format,
      detail: prefs.detail,
      model: imageModel,
      shape: this.config.get("api.image.aspectRatio") || "",
    });

    const final = prefs.detail === "short" ? await this.truncateImagePrompt(prompt) : prompt;
    this._rememberPromptFormat(final, prefs.format);
    return final;
  },

  // Which format each recent prompt was written in, so generateImage adds the
  // Style Preset bookends by how the prompt was written rather than by the
  // model drawing it. They differ when a new character's local model fails
  // and the hosted fallback draws the prompt already written for it — a
  // fragments prompt with an opening bolted on brought back the doubled
  // "…illustration of A … photograph of". An edited prompt isn't found here,
  // and falls back to the drawing model's setting.
  _rememberPromptFormat(prompt, format) {
    if (!prompt) return;
    if (!this._promptFormats) this._promptFormats = new Map();
    this._promptFormats.set(prompt.trim(), format);
    while (this._promptFormats.size > 20) this._promptFormats.delete(this._promptFormats.keys().next().value);
  },

  // Character Gen's active Look, or null when none is set (then the Style
  // Preset and Mood apply).
  getActiveLook() {
    const look = window.PromptLook?.normalise(this.config.get("api.image.activeLook"));
    return look && !window.PromptLook.isEmpty(look) ? look : null;
  },

  // How a model wants its prompt written, from its Settings. Unticked models
  // default to prose rather than tags: a modern model whose "Natural-language
  // prompts" box was never ticked would otherwise start getting tag soup.
  imagePromptPrefs(model) {
    const settings = (this.config.get("api.image.modelSettings") || {})[model] || {};
    const format = settings.isFlux
      ? "fragments"
      : /illustrious|pony|sdxl|noob|animagine|\bsd-?1\.5\b/i.test(model || "") ? "tags" : "prose";
    return { format, detail: settings.promptLengthPref === "short" ? "short" : "rich" };
  },

  // The one image-prompt writer, behind Draft Prompt, Gen 4, Compare Models,
  // batch, Inspire Me and the Prompt Builder. Streams and is resumable, so a
  // phone locking mid-write picks up where it left off rather than paying for
  // the call again.
  //
  // spec: {
  //   subject: { kind: "idea", idea } | { kind: "card", name, description, cardType, direction },
  //   look,          // PromptLook look, or null
  //   legacyStyle,   // { style, mood } from the Style Preset / Mood, used when there's no look
  //   format,        // "fragments" | "prose" | "tags"
  //   detail,        // "short" | "rich" | "max"
  //   surprise,      // bold choices for everything left to the AI
  //   variations,    // 0, or a number of takes to write
  //   model, shape,
  // }
  // Returns the prompt, or [{ label, prompt }] when variations were asked for.
  async writeImagePrompt(spec, { onStream = null, label = "Image prompt" } = {}) {
    const instruction = this.buildImagePromptWriterInstruction(spec);
    const temperature = spec.surprise ? 0.85 : spec.subject?.kind === "idea" ? 0.6 : 0.4;
    const data = {
      model: this.config.get("api.text.model"),
      messages: [{ role: "user", content: instruction }],
      max_tokens: 8192,
      temperature,
      stream: true,
      resumable: true,
      __jobLabel: label,
    };

    let response;
    try {
      response = await this.makeRequest("/api/text/chat/completions", data, false, true);
    } catch (error) {
      console.error("Text API request failed:", error);
      throw new Error(`Failed to call text API for image prompt generation: ${error.message}`);
    }

    const raw = await this.handleStreamResponse(response, onStream || (() => {}));
    if (!raw || !raw.trim()) throw new Error("Text API returned an empty image prompt");

    if (spec.variations) {
      const takes = this._parsePromptTakes(raw);
      if (!takes.length) throw new Error("The text model didn't return the variations in a readable form — try again");
      return takes;
    }
    return this._cleanWrittenPrompt(raw);
  },

  // Strips what models wrap a prompt in despite being told not to.
  _cleanWrittenPrompt(text) {
    let t = String(text || "").trim();
    t = t.replace(/^(here(?:'s| is)[^\n]*:|prompt:|image prompt:)\s*/i, "");
    t = t.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
    if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1);
    return t.trim();
  },

  _parsePromptTakes(text) {
    const takes = [];
    const re = /^#{2,4}\s*TAKE\s*\d+\s*[:\-–—]\s*(.*)$/gim;
    const heads = [...String(text).matchAll(re)];
    heads.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
      const prompt = this._cleanWrittenPrompt(text.slice(start, end));
      if (prompt) takes.push({ label: m[1].trim() || `Take ${i + 1}`, prompt });
    });
    return takes;
  },

  buildImagePromptWriterInstruction(spec) {
    const PL = window.PromptLook;
    const subject = spec.subject || {};
    const format = ["fragments", "prose", "tags"].includes(spec.format) ? spec.format : "prose";
    const detail = ["short", "rich", "max"].includes(spec.detail) ? spec.detail : "rich";
    const look = spec.look ? PL.normalise(spec.look) : null;
    const parts = [];

    parts.push(`You write prompts for an AI image model${spec.model ? ` (${spec.model})` : ""}. Your prompt is sent to the image model exactly as you write it, so it must describe a finished picture.`);

    // ── Subject ──
    if (subject.kind === "card") {
      let cardNote = "";
      if (subject.cardType === "group") {
        cardNote = "\nThis is a GROUP card: show two or three of its characters together in a shared setting, not one person.";
      } else if (subject.cardType === "scenario") {
        cardNote = "\nThis is a SCENARIO / LOCATION card: the setting is the subject. Any figures are part of the environment.";
      }
      parts.push(`SUBJECT — a roleplay character card. Read the profile and take from it:
- apparent gender, approximate age, species or ethnicity if notable
- exact hair colour and style, eye colour, distinctive features (scars, tattoos, unusual traits)
- specific clothing that fits their role and world, not generic
- one expression or body-language cue that shows their dominant personality
- one concrete setting from their story or scenario${cardNote}

Character name (context only — never write it in the prompt): ${subject.name || "Unknown"}

Profile:
${subject.description || ""}`);
      if (subject.direction && subject.direction.trim()) {
        parts.push(`USER DIRECTION (high priority — steer the picture this way, overriding profile details where they conflict):\n${subject.direction.trim()}`);
      }
    } else {
      parts.push(`SUBJECT — the user's idea:\n"""${(subject.idea || "").trim()}"""\nKeep everything the user specified: subjects, counts, actions, clothing, colours, any text to show, and anything they excluded. Never contradict or drop it. Fill whatever they left open with concrete visual choices.`);
    }

    // ── Look ──
    if (look) {
      const lines = PL.chosenLines(look);
      const open = PL.openGroups(look);
      let block = "LOOK — the user chose these. Every one must appear in the prompt:";
      block += lines.length ? "\n" + lines.map(l => `- ${l.label}: ${l.values.join(", ")}`).join("\n") : "\n- (nothing specific)";
      if (look.extra) block += `\nAlso: ${look.extra}`;
      if (look.fromImage) block += `\nMatch the style of a reference image described as: ${look.fromImage}`;
      if (open.length) {
        block += `\n\nLeft to you: ${open.join(", ")}. Choose what fits the subject and the chosen look`;
        block += spec.surprise
          ? " — and be bold: distinctive, unexpected but coherent choices, not the safe default."
          : ".";
      }
      block += "\nIf two choices contradict each other (for example deep focus and extreme bokeh), keep the one that matters most for this picture and drop the other.";
      parts.push(block);
    } else if (spec.legacyStyle) {
      parts.push(this._legacyStyleBlock(spec.legacyStyle, format));
    }

    // ── 🔞 NSFW (Prompt Builder checkbox) ──
    // Steers towards nudity and erotic imagery instead of the covered-up
    // default. The adult rule is not optional and stays in whatever else
    // changes here.
    if (spec.nsfw) {
      parts.push(`MATURE CONTENT — the user has turned on NSFW for this adult-only tool. Nudity and sensual or erotic imagery are wanted: describe bodies, skin, nudity and a sensual pose plainly and specifically, rather than covering up, cropping away or only implying. Keep it visual — no story, dialogue or acts described beyond the pose in this single picture.${format === "tags" ? " Start the tags with \"nsfw\"." : ""}
Every character is an adult, clearly 18 or older with an adult face and body. Never sexualise anyone who could read as a minor: no childlike bodies, features or proportions, and no school settings or uniforms. If the subject could be read as young, make them unmistakably adult.`);
    }

    // ── What every prompt covers ──
    const isPhoto = look ? PL.isPhotoMedium(look) : /realistic|cinematic|photo/i.test(spec.legacyStyle?.style || "");
    // A card's picture is its portrait, so unless a look picks the framing
    // the face must read clearly; left to itself the model sometimes chose a
    // wide or full-body shot with a tiny face.
    let framingNote = "";
    if (subject.kind === "card" && !look?.picks?.framing?.length) {
      framingNote = subject.cardType === "group"
        ? " — frame the group so every face is clearly visible"
        : subject.cardType === "scenario"
          ? " — a wide establishing view of the place"
          : " — a character portrait that shows the face clearly: head-and-shoulders, chest-up or waist-up, unless the user direction asks for something else";
    }
    parts.push(`COVER, in this order:
1. Medium and genre${subject.kind === "card" ? ", then the subject: who, appearance, outfit" : ", then the subject"}
2. Materials and surface texture of what matters (fabric, metal, skin, ceramic…)
3. Pose and expression
4. Setting or background
5. Lighting: its source, direction and colour, chosen for this picture — not the same dramatic look every time
${isPhoto ? "6. Lens and focus\n7" : "6"}. Finish (grain, gloss, line work, brushwork — whatever suits the medium) and palette
${isPhoto ? "8" : "7"}. Framing, angle and composition${spec.shape ? `, composed for a ${this._shapeWord(spec.shape)} (${spec.shape}) frame` : ""}${framingNote}

Describe only what can be seen: no sounds, smells, backstory, or personality words with no visible form. Never use a character's name: the image model can't know who that is and may write it into the picture as text.${format === "tags" ? "" : " No quality filler such as \"masterpiece\", \"best quality\", \"8k\" or \"trending on artstation\"."}`);

    // ── Format ──
    const words = { short: "40–80", rich: "100–180", max: "180–300" }[detail];
    const maxNote = detail === "max" ? " Spend the extra words on fine surface detail: stitching, wear, reflections, skin and fabric texture." : "";
    if (format === "fragments") {
      parts.push(`FORMAT — fragments, like a photographer's shot list. Short declarative fragments, each ending with a full stop, most of them 2–8 words. Example of the style: "Analog cyberpunk street photography. Young woman, early twenties. Clean white ceramic plates, black servo joints. Specular highlights on the ceramic. Hand on hip."
Two blocks separated by one blank line: first the medium and the subject (who, appearance, outfit, materials, pose, expression); then the look (lighting, lens and focus, finish, palette, background, composition). No flowing sentences, lists, labels or headings. About ${words} words.${maxNote}`);
    } else if (format === "prose") {
      parts.push(`FORMAT — plain descriptive prose, as a caption of the finished picture: one or two paragraphs of full sentences. Open with one sentence naming the medium and the subject together (e.g. "A semi-realistic 2.5D anime illustration of a silver-haired woman in her late twenties…"). Name the medium once — never "an illustration of an image of a portrait of". No lists, labels or tags. About ${words} words.${maxNote}`);
    } else {
      parts.push(`FORMAT — comma-separated tags for a tag-trained model (Danbooru-style tags where they fit), in this order: subject count and type, appearance, outfit, pose and expression, setting, lighting, composition, medium and style. End with "masterpiece, best quality". No sentences. About ${{ short: "20–35", rich: "35–60", max: "60–90" }[detail]} tags.`);
    }

    // ── Output ──
    const n = parseInt(spec.variations, 10) || 0;
    if (n > 1) {
      parts.push(`OUTPUT — ${n} takes. Each keeps the subject and every one of the user's choices, and changes exactly one thing that was left open (angle, lighting, framing, pose or setting) — a different thing in each take. Write exactly this, with nothing before or after:
${Array.from({ length: n }, (_, i) => `### TAKE ${i + 1}: <what changed, 2–5 words>\n<the full prompt>`).join("\n")}`);
    } else {
      parts.push("OUTPUT — only the prompt itself: no title, preamble, explanation, quotes or markdown.");
    }

    return parts.join("\n\n");
  },

  // A Style Preset's look as plain cues, minus the SD-era quality filler that
  // modern models ignore or render oddly. Also seeds the builder's built-in
  // "style preset" looks.
  styleCues(style) {
    const filler = /^(masterpiece|best quality|high quality|highly detailed|ultra-detailed|high resolution|8k( resolution)?|trending on artstation|artstation|professional (illustration|quality)|museum quality fine art|masterpiece (anime film still|illustration))$/i;
    return (this.getImageStyleTags(style).suffix || "").split(",").map(t => t.trim()).filter(t => t && !filler.test(t));
  },

  _shapeWord(shape) {
    const [w, h] = String(shape).split(":").map(Number);
    if (!(w > 0 && h > 0)) return "square";
    return w === h ? "square" : w > h ? "landscape" : "portrait";
  },

  // The pre-Look Style Preset and Mood, for when no Look is set. Tag and prose
  // prompts for a preset with an opening ("… illustration of") still get that
  // opening and its tags added by generateImage, so the writer starts at the
  // subject. Fragment prompts carry the style themselves.
  _legacyStyleBlock({ style = "", mood = "" } = {}, format) {
    let styleName = "";
    let cues = [];
    let prefix = "";
    if (style === "custom") {
      styleName = (this.config.get("api.image.customStyleText") || "").trim();
    } else if (style) {
      styleName = style === "realistic" ? "Realistic photography" : style.replace(/-/g, " ");
      prefix = this.getImageStyleTags(style).prefix || "";
      cues = this.styleCues(style);
    }
    const lines = [];
    if (styleName) {
      lines.push(`STYLE — "${styleName}". Bias the whole prompt towards it.${cues.length ? ` Its hallmarks: ${cues.join("; ")}.` : ""}`);
      if (prefix && format !== "fragments") {
        lines.push(`The app puts "${prefix}" in front of your prompt and adds the style's tags after it, so start directly with the subject in lowercase (e.g. "a young woman with…") and don't repeat the style words.`);
      }
    }
    if (mood) {
      lines.push(`MOOD — "${mood.replace(/-/g, " ")}": let the lighting, expression and atmosphere carry it.`);
    }
    return lines.join("\n") || "LOOK — nothing chosen: pick a medium, lighting and composition that suit the subject.";
  },

  async truncateImagePrompt(prompt) {
    const MAX_LENGTH = 1000;
    // Target 800 chars so that style tags (~200 chars) still fit within the 1000 total limit
    const AI_TARGET = 800;

    if (prompt.length <= MAX_LENGTH) return prompt;

    console.log(`🔧 Image prompt too long (${prompt.length} chars). Using AI to shorten to ${AI_TARGET} chars...`);

    const buildShortenRequest = (target, text) => ({
      model: this.config.get("api.text.model"),
      messages: [
        {
          role: "user",
          content: `Rewrite the following image generation prompt so it is under ${target} characters total. Preserve the most visually important details: subject, physical appearance, outfit, expression, and setting. Cut filler words, repetition, and anything non-visual. Output ONLY the rewritten prompt — no explanation, no preamble, no labels.\n\nOriginal prompt:\n${text}\n\nRewritten prompt (under ${target} characters):`,
        },
      ],
      // Give enough tokens so the AI can gracefully finish the sentence without a hard cutoff
      max_tokens: 500,
      temperature: 0.2,
      stream: false,
    });

    const tryShorten = async (target, text) => {
      const result = await this.makeRequest("/api/text/chat/completions", buildShortenRequest(target, text), false, false);
      return this.processNormalResponse(result).trim();
    };

    try {
      // First pass: target AI_TARGET chars
      let shortened = await tryShorten(AI_TARGET, prompt);
      console.log(`🔍 First pass: ${shortened.length} chars`);

      if (!shortened || shortened.length === 0) {
        console.warn("⚠️ AI returned empty prompt on first pass, trying fallback truncation");
        return prompt.substring(0, MAX_LENGTH).trim();
      }

      if (shortened.length <= MAX_LENGTH) {
        console.log(`✅ Shortened successfully to ${shortened.length} chars`);
        return shortened;
      }

      // Second pass: still too long — retry with a tighter target and the already-shortened text
      console.warn(`⚠️ First pass still ${shortened.length} chars. Retrying with stricter target...`);
      const strictTarget = Math.floor(MAX_LENGTH * 0.75); // 750 chars
      let retry = await tryShorten(strictTarget, shortened);
      console.log(`🔍 Second pass: ${retry.length} chars`);

      if (retry && retry.length > 0 && retry.length <= MAX_LENGTH) {
        console.log(`✅ Shortened on second pass to ${retry.length} chars`);
        return retry;
      }

      // Last resort: trim at a sentence boundary to avoid mid-word cuts
      console.warn(`⚠️ AI still over limit after two passes (${retry?.length ?? "?"}). Trimming at sentence boundary.`);
      const candidate = (retry && retry.length > 0) ? retry : shortened;
      const trimmed = candidate.substring(0, MAX_LENGTH);
      const lastPeriod = trimmed.lastIndexOf(".");
      const lastComma = trimmed.lastIndexOf(",");
      const cutPoint = lastPeriod > MAX_LENGTH * 0.6
        ? lastPeriod + 1
        : lastComma > MAX_LENGTH * 0.6
          ? lastComma
          : MAX_LENGTH;
      return trimmed.substring(0, cutPoint).trim();

    } catch (error) {
      console.error("❌ AI shortening failed, falling back to sentence-boundary truncation:", error);
      const trimmed = prompt.substring(0, MAX_LENGTH);
      const lastPeriod = trimmed.lastIndexOf(".");
      const lastComma = trimmed.lastIndexOf(",");
      const cutPoint = lastPeriod > MAX_LENGTH * 0.6
        ? lastPeriod + 1
        : lastComma > MAX_LENGTH * 0.6
          ? lastComma
          : MAX_LENGTH;
      return trimmed.substring(0, cutPoint).trim();
    }
  },

  buildDirectImagePrompt(characterDescription, characterName) {
    const appearanceMatch = characterDescription.match(
      /\*\*Appearance:\*\*([\s\S]*?)(?=\*\*My Story:|\*\*How I Am|\*\*How I Operate|\n##)/i,
    );
    const appearanceText = appearanceMatch ? appearanceMatch[1].trim() : "";
    const personalityTraits = this.extractPersonalityTraits(characterDescription);

    let prompt = `A highly detailed portrait of ${characterName || "a character"}. `;

    if (appearanceText) {
      const cleanedAppearance = appearanceText
        .replace(/\*\*/g, "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      prompt += cleanedAppearance + " ";
    }

    if (personalityTraits.length > 0) {
      const moodMap = {
        sarcastic: "with a slight smirk and knowing eyes",
        stoic: "with a calm, composed expression",
        cynical: "with a skeptical, world-weary gaze",
        optimistic: "with bright, hopeful eyes and a warm smile",
        shy: "with a gentle, reserved demeanor",
        confident: "with bold, self-assured posture",
        mysterious: "with an enigmatic expression",
        friendly: "with an approachable, warm expression",
        serious: "with focused, intense eyes",
        playful: "with a mischievous glint in their eyes",
      };
      const mood = moodMap[personalityTraits[0]] || "with an expressive face";
      prompt += mood + ". ";
    }

    prompt += " Appropriate background that suits the character's setting and personality.";
    return prompt;
  },

  extractPersonalityTraits(text) {
    const traits = [];
    const t = text.toLowerCase();
    if (t.includes("sarcastic")) traits.push("sarcastic");
    if (t.includes("stoic") || t.includes("stoicism")) traits.push("stoic");
    if (t.includes("cynical")) traits.push("cynical");
    if (t.includes("optimistic") || t.includes("optimism")) traits.push("optimistic");
    if (t.includes("formal")) traits.push("formal");
    if (t.includes("vulgar") || t.includes("crass")) traits.push("rough-speaking");
    if (t.includes("quiet") || t.includes("reserved")) traits.push("reserved");
    if (t.includes("graceful")) traits.push("graceful");
    if (t.includes("clumsy")) traits.push("clumsy");
    if (t.includes("restless")) traits.push("restless");
    if (t.includes("menacing") || t.includes("intimidating")) traits.push("menacing");
    return traits.length > 0 ? traits.join(", ") : "complex personality";
  },

  getImageStyleTags(style) {
    const s = (prefix, suffix) => ({ prefix, suffix });
    switch (style) {
      case "2.5d-realistic-anime":
      case "semi-realistic":
        return s("High-quality 2.5D semi-realistic anime illustration of", "detailed digital painting, 2.5D anime aesthetic, semi-realistic anime render, modern manhwa cover art style, highly detailed features, glossy textures, cinematic dual lighting, dramatic atmosphere, masterpiece");
      case "realistic":
        return s("A hyper-realistic photograph of", "DSLR photo, 85mm portrait lens, natural lighting, shallow depth of field, 8k resolution, photorealistic, highly detailed skin and features, masterpiece");
      case "anime":
        return s("Anime illustration of", "masterpiece, best quality, anime art, vibrant colors, detailed eyes, clean line art, soft cel shading, expressive, 2D illustration");
      case "hand-drawn-anime":
        return s("Traditional hand-drawn anime artwork of", "hand-drawn anime, intricate ink line art, cel shading, classic 90s anime aesthetic, paper texture, traditional media, masterpiece illustration");
      case "painted-anime":
        return s("Painted anime artwork of", "painted anime, rich canvas texture, expressive brushstrokes, oil painting technique, vibrant colors, masterpiece illustration");
      case "waifu":
        return s("Waifu anime illustration of", "waifu style, best quality, ultra-detailed, masterpiece, soft lighting, large expressive eyes, detailed hair, appealing design");
      case "sexy":
        return s("A glamorous, alluring portrait of", "masterpiece, best quality, glamorous lighting, confident pose, elegant figure, radiant skin, cinematic composition, highly detailed");
      case "comic":
      case "comic-book":
        return s("Western comic book art of", "comic book style, graphic novel, bold ink outlines, halftone shading, dynamic composition, vibrant comic colors, professional illustration");
      case "cinematic":
        return s("A cinematic film still of", "cinematic photography, anamorphic lens, dramatic chiaroscuro lighting, volumetric light, movie still, epic composition, photorealistic, masterpiece");
      case "digital-art":
        return s("High-quality digital illustration of", "digital painting, highly detailed, concept art, trending on artstation, masterpiece, professional illustration");
      case "fantasy":
        return s("Epic digital fantasy art of", "fantasy digital painting, stylized illustration, detailed fantasy art, dramatic lighting, epic atmosphere, intricate costume design, masterpiece");
      case "cyberpunk":
        return s("Cyberpunk digital art of", "cyberpunk aesthetic, neon-lit rain-soaked streets, dark futuristic dystopia, holographic signage, synthwave color palette, high tech low life, highly detailed");
      case "sci-fi":
        return s("Sci-fi digital art of", "science fiction illustration, futuristic, highly detailed, dramatic lighting, high tech, digital painting, masterpiece");
      case "3d-render":
        return s("A high-quality 3D render of", "octane render, Unreal Engine 5, ray tracing, subsurface scattering, physically based rendering, studio lighting, CGI, masterpiece");
      case "watercolor":
        return s("A watercolor painting of", "watercolor illustration, wet-on-wet technique, soft diffused edges, translucent washes, pastel tones, watercolor paper texture, beautiful fine art");
      case "pixel":
        return s("Pixel art of", "pixel art, 16-bit SNES style, crisp pixels, limited color palette, retro game sprite, high quality pixel illustration");
      case "oil-painting":
        return s("A classical oil painting portrait of", "oil on canvas, old masters technique, impasto brushwork, rich saturated colors, Rembrandt lighting, museum quality fine art, highly detailed");
      case "concept-art":
        return s("Professional character concept art of", "game concept art, character design sheet, clean rendering, professional illustration, artstation, dynamic lighting, detailed costume design");
      case "grunge-anime":
        return s("Modern edgy 2D anime illustration of", "grunge aesthetic, highly desaturated color palette, sharp messy line art, detailed streetwear fashion, chaotic expressive vibe, flat cel shading, Pixiv ranking style, masterpiece");
      case "gothic-anime":
        return s("Semi-realistic anime illustration of", "dark fantasy gothic, high contrast lighting, dramatic shadows, detailed concept art, palette of deep blacks, stark whites, luminous crimson");
      case "gothic":
        return s("Dark gothic fantasy illustration of", "gothic horror, dramatic chiaroscuro lighting, deep shadows, ornate Victorian detail, cathedral motifs, haunting atmosphere, highly detailed, masterpiece");
      case "art-nouveau":
        return s("Art Nouveau illustration of", "Art Nouveau style, Alphonse Mucha inspired, flowing organic lines, decorative floral border motifs, elegant curves, muted jewel tones, vintage poster art, ornamental");
      case "noir":
        return s("Film noir black and white photograph of", "film noir, black and white photography, hard chiaroscuro lighting, deep shadows, venetian blind light streaks, 1940s aesthetic, grainy 35mm, dramatic contrast");
      case "ink-sketch":
        return s("Detailed pen and ink sketch of", "pen and ink illustration, cross-hatching, fine line art, monochrome, technical pen drawing, editorial illustration style, high contrast black and white");
      case "storybook":
        return s("Whimsical storybook illustration of", "children's book illustration, warm inviting palette, soft rounded shapes, charming storybook art, gentle painterly style, fairy tale aesthetic, detailed background");
      case "manhwa":
        return s("Korean manhwa style illustration of", "manhwa art style, webtoon, clean crisp line art, soft cel shading, expressive large eyes, detailed hair, Korean comic aesthetic, professional webtoon quality");
      case "chibi":
        return s("Cute chibi anime illustration of", "chibi style, super deformed SD, large head small body, adorable rounded features, pastel colors, clean lines, kawaii, chibi character art");
      case "vintage":
        return s("Vintage retro illustration of", "vintage illustration, 1950s magazine style, mid-century modern design, muted aged color palette, halftone texture, nostalgic Americana, retro poster art, masterpiece");
      case "prismatic-anime":
          return s("Luminescent anime illustration of","dynamic lighting, glowing lens flares, floating light particles, shattered prisms, vibrant cyan and magenta, high contrast, masterpiece");
      case "genshin":
        return s("3D cel-shaded anime illustration of", "Genshin Impact style, official game art, intricate fantasy outfit, glowing elemental magic, soft vibrant lighting, high quality 3D anime render, masterpiece");
      case "dark-graphic-novel":
        return s("Gritty graphic novel illustration of", "dark fantasy comic style, heavy inking, crosshatching shading, muted earth tones, detailed line art, dramatic shadows, masterpiece");
      case "arcane":
        return s("Arcane-style painted 3D illustration of", "Arcane League of Legends style, Fortiche Production, hand-painted 3D, rich textured brushstrokes, dramatic cinematic lighting, stylized realism, masterpiece");
      case "disney-pixar":
        return s("Disney Pixar 3D animated character of", "Pixar style, Disney animation, expressive character design, soft subsurface scattering, vibrant warm colors, charming appeal, high quality 3D render");
      case "ghibli":
        return s("Studio Ghibli anime illustration of", "Studio Ghibli style, Hayao Miyazaki, soft watercolor backgrounds, lush nature detail, gentle hand-drawn aesthetic, warm nostalgic lighting, masterpiece anime film still");
      case "90s-dark-animation":
        return s("90s dark animation style illustration of", "Batman The Animated Series style, dark deco, flat cel shading, heavy black shadows, moody atmosphere, limited color palette, noir comic animation, masterpiece");
      case "voxel":
        return s("Voxel art 3D character of", "voxel art style, blocky 3D, isometric, crisp cubes, Minecraft aesthetic, clean sharp edges, vibrant colors, game asset, high quality voxel render");
      case "propaganda-poster":
        return s("Propaganda poster illustration of", "Soviet constructivist propaganda poster, bold geometric shapes, limited palette of red black and cream, heroic pose, stencil typography, WPA era, striking graphic design");
      case "stained-glass":
        return s("Stained glass window art of", "stained glass cathedral window, luminous translucent colors, bold lead lines, mosaic fragments, sacred geometry, backlit glowing radiance, medieval gothic style, masterpiece");
      case "ukiyo-e":
        return s("Japanese ukiyo-e woodblock print of", "ukiyo-e style, Japanese woodblock print, Hokusai and Hiroshige influence, flat color planes, bold outlines, washi paper texture, Edo period aesthetic, traditional Japanese art, masterpiece");
      case "pin-up":
        return s("Classic pin-up illustration of", "pin-up art, Vargas style, 1940s cheesecake, playful boudoir glamour, airbrushed skin, vintage Americana, soft curves, retro pin-up girl, masterpiece illustration");
      case "hentai":
        return s("Ecchi hentai anime illustration of", "hentai anime style, glossy rendering, detailed curves, soft lighting, blush tones, cel shading, high quality, provocative pose, masterpiece");
      case "frazetta":
        return s("Frank Frazetta fantasy painting of", "Frazetta style, classic sword and sorcery, dramatic oil painting, dramatic chiaroscuro, powerful athletic physique, primal energy, dark fantasy, iconic 1970s fantasy art, masterpiece");
      case "manhwa-18":
        return s("Mature manhwa webtoon illustration of", "manhwa 18+ art style, glossy clean rendering, detailed anatomy, dramatic lighting, highly stylized, Korean mature webtoon aesthetic, professional quality");
      case "yaoi-bl":
        return s("Yaoi boys love anime illustration of", "yaoi BL style, elegant bishounen, delicate features, long-limbed, rose-tinted palette, soft romantic atmosphere, flowing hair, graceful pose, shounen-ai, masterpiece");
      default: return { prefix: "", suffix: "" };
    }
  },

  async describeReferenceImage(imageDataUrl, manualHint = "") {
    if (!imageDataUrl) throw new Error("Reference image is required");

    const model = this.config.get("api.text.visionModel") || this.config.get("api.text.model");
    if (!model) throw new Error("No vision model or text model configured");

    const systemPrompt =
      "You describe reference character images for roleplay card generation. Output one concise paragraph that captures visible appearance, clothing, age cues, emotion, posture, accessories, and likely setting. Do not mention uncertainty, policy, or analysis steps.";

    const userText = manualHint
      ? `Use this user hint while describing: ${manualHint}`
      : "Describe this character image for roleplay character generation.";

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.3,
      // Vision models that think first (Gemini Flash) spend part of the budget
      // on reasoning before writing anything; at 500 a longer think used it all
      // up, so roughly one analysis in three came back cut off or empty.
      max_tokens: 2048,
      stream: false,
    };

    const response = await this.makeRequest("/chat/completions", data, false, false);
    return this._visionTextOrThrow(response, "Image analysis");
  },

  // A cut-off vision reply is either empty or half a sentence (or, via the
  // reasoning_content fallback, the model's thinking) — none of which should
  // land in a description field as if it were a result.
  _visionTextOrThrow(response, label) {
    const text = (this.processNormalResponse(response) || "").trim();
    if (this.lastFinishReason === "length" || !text) {
      throw new Error(`${label} was cut off before the model finished — please try again.`);
    }
    return text;
  },

  async extractStyleFromImage(imageDataUrl) {
    if (!imageDataUrl) throw new Error("Image is required");

    const model = this.config.get("api.text.visionModel") || this.config.get("api.text.model");
    if (!model) throw new Error("No vision model or text model configured");

    const systemPrompt =
      "You are an expert art critic and prompt engineer. Analyze the provided image and output ONE concise paragraph describing ONLY its artistic style. Do NOT describe the subjects, characters, or actions in the image. Focus strictly on the medium (e.g. watercolor, digital art, 3D render, oil painting), lighting, shading technique, line art style, color palette, camera angle/framing (if relevant to style), and overall aesthetic vibe. Do not include preamble or labels.";

    const data = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the artistic style from this image." },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 2048,
      stream: false,
    };

    const response = await this.makeRequest("/api/text/chat/completions", data, false, false);
    return this._visionTextOrThrow(response, "Style extraction");
  },

  // Local image generation via WebUI Forge — called directly from the browser,
  // bypassing the proxy server (which runs in Docker and can't reach host 127.0.0.1).
  // Forge's API has CORS open by default when launched with --api.
  async generateForgeImage(prompt) {
    const forgeUrl = (this.config.get("api.image.localForge.url") || "http://127.0.0.1:7860").replace(/\/$/, "");
    const txt2imgUrl = `${forgeUrl}/sdapi/v1/txt2img`;

    // Read steps & cfg_scale from the shared Settings fields (same ones used by cloud API).
    // Default cfg_scale to 7 — safe for SDXL/SD1.5; FLUX users should set it to 1 via Settings.
    const settingsSteps   = parseInt(this.config.get("api.image.settings.steps"))   || 20;
    const settingsCfg     = parseFloat(this.config.get("api.image.settings.cfgScale")) || 1;

    // Resolve width/height from aspect ratio setting
    const aspectRatio = this.config.get("api.image.aspectRatio") || "3:4";
    const ratioMap = {
      "1:1":  { width: 1024, height: 1024 },
      "9:16": { width: 768,  height: 1344 },
      "16:9": { width: 1344, height: 768  },
      "3:4":  { width: 896,  height: 1152 },
      "4:3":  { width: 1152, height: 896  },
    };
    const dims = ratioMap[aspectRatio] || ratioMap["3:4"];

    const forgePayload = {
      prompt,
      steps:        settingsSteps,
      cfg_scale:    settingsCfg,
      width:        dims.width,
      height:       dims.height,
      sampler_name: "Euler",
      scheduler:    "Simple",
    };
    console.log("🔧 Forge payload:", JSON.stringify(forgePayload));

    let response;
    try {
      // Direct browser fetch — no proxy, so host-local Forge is reachable
      response = await fetch(txt2imgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forgePayload),
      });
    } catch (connErr) {
      throw new Error(
        `Cannot connect to Forge at ${forgeUrl}. ` +
        `Make sure it is running with the --api flag and that no firewall is blocking port 7860. ` +
        `(${connErr.message})`
      );
    }

    if (!response.ok) {
      let detail = response.statusText;
      try { const j = await response.json(); detail = j.detail || j.error?.message || detail; } catch (_) {}
      throw new Error(`Forge returned ${response.status}: ${detail}`);
    }

    const data = await response.json();
    const images = data.images;
    if (!images || images.length === 0) {
      throw new Error("Forge returned no images in response");
    }

    // ── DIAGNOSTIC (temporary) ──────────────────────────────────────────────
    console.group("🔧 Forge response diagnostics");
    console.log("images array length:", images.length);
    images.forEach((img, i) => {
      const preview = typeof img === "string" ? img.slice(0, 80) : img;
      console.log(`images[${i}] type=${typeof img} length=${typeof img === "string" ? img.length : "N/A"} starts-with:`, preview);
    });
    console.groupEnd();
    // ── END DIAGNOSTIC ───────────────────────────────────────────────────────

    // images[0] is a raw base64 PNG — decode it to a blob URL.
    // Forge may line-wrap the base64 string at 76 chars (RFC 2045).
    // atob() throws on any whitespace, so strip it first.
    const rawImg = images[0];
    // Handle case where Forge already prefixes with "data:..."
    if (typeof rawImg === "string" && rawImg.startsWith("data:")) {
      console.log("🔧 Forge returned a data URI directly — using as-is");
      // Create blob from it for consistency
      const res2 = await fetch(rawImg);
      const blob2 = await res2.blob();
      return URL.createObjectURL(blob2);
    }
    const cleanB64 = rawImg.replace(/\s/g, "");
    console.log("🔧 cleanB64 length:", cleanB64.length, "first 40 chars:", cleanB64.slice(0, 40));
    const byteChars = atob(cleanB64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    // Detect mime type from PNG/JPEG magic bytes
    const mimeType = (byteArray[0] === 0xFF && byteArray[1] === 0xD8) ? "image/jpeg" : "image/png";
    console.log("🔧 Binary size:", byteArray.length, "bytes | detected mime:", mimeType, "| first bytes:", byteArray[0], byteArray[1], byteArray[2], byteArray[3]);
    const blob = new Blob([byteArray], { type: mimeType });
    return URL.createObjectURL(blob);
  },

  // ── Multi-image combining (Playground's Combine tab) ────────────────────────
  // Sends 2+ reference images + an instruction to a model that supports
  // multiple image inputs in one generation (e.g. qwen-image-3-pro,
  // reve/2.1/remix, xai/grok-imagine-image/v2.0/edit — see nano-gpt's model
  // catalog). This is NOT the same request shape as editImage(): per
  // nano-gpt's docs, multi-reference calls use a distinct endpoint
  // (POST {base}/images) with an `input_references` array field, not the
  // OpenAI-compatible /images/generations or /images/edits shapes — hence its
  // own proxy route (/api/image/combine) rather than reusing editImage's.
  async combineImages({ images, instruction, model }) {
    if (!images || images.length < 2) throw new Error("At least two images are required to combine.");
    const trimmedInstruction = (instruction || "").trim();
    if (!trimmedInstruction) throw new Error("A combining instruction is required.");

    const combineModel = model || this.config.get("api.image.combineModel") || "";
    if (!combineModel) throw new Error("Choose a model that supports combining multiple images first.");

    const apiKey = this.config.get("api.image.apiKey");
    const apiUrl = this.config.get("api.image.baseUrl");
    if (!apiKey || !apiUrl) throw new Error("Please configure your Image API settings first.");

    const payload = {
      model: combineModel,
      prompt: trimmedInstruction,
      input_references: images,
      n: 1,
    };

    console.log("=== SENDING IMAGE COMBINE REQUEST ===");
    console.log("Combine model:", combineModel);
    console.log("Reference image count:", images.length);

    // Combining is the slowest call in the app — two full-size reference images
    // going up, a multi-image model working on them — and it used to be the one
    // image operation with no resumable job behind it: a phone locking mid-run
    // lost a result that had already been paid for. It now goes through
    // makeRequest on its own proxy route, which buffers the result server-side
    // and collects it on reconnect exactly as Generate and Edit do.
    payload.resumable = true;
    payload.__jobLabel = "Image combine";
    const startedAt = performance.now();
    const response = await this.makeRequest("/api/image/combine", payload, true);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Image Combine API error response:", errorText);
      let errorMessage = errorText;
      try {
        const errData = JSON.parse(errorText);
        errorMessage = errData.error?.message || errData.error?.details || errData.message || errorText;
      } catch (e) {}
      throw new Error(`Image Combine API Error (${response.status}): ${errorMessage}`);
    }

    const data = await response.json();
    if (data.error) {
      console.error("Image Combine API returned error object:", data.error);
      throw new Error(`Image Combine API Error: ${data.error.message || data.error.details || data.error}`);
    }

    const resultUrl = (data.data && data.data.length > 0 && data.data[0].url) || data.image || data.url;
    if (!resultUrl) {
      console.error("Unexpected image combine API response format. Full response:", data);
      throw new Error("Unexpected response format from Image Combine API: " + JSON.stringify(data).slice(0, 300));
    }
    recordImageModelRun(combineModel, performance.now() - startedAt, this.config);
    return resultUrl;
  },

});
