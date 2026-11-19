// Which image jobs each model can do, and which model to reach for. Loaded by
// the page (before config.js) and by the proxy's prompt host
// (proxy/runs/prompt-host.js): no page access in here.

// ── Image-model capabilities ────────────────────────────────────────────────
// Which of the image jobs a given model can actually do. Most providers don't
// report this (nano-gpt's /image-models reports input types, which is used for
// the defaults, but nothing about Combine), so the app used to guess from the name alone (_looksEditCapable in
// image-playground.js), which is unreliable: a plain text-to-image model
// silently ignores a source image rather than erroring, so a wrong guess
// costs a credit and returns something with no resemblance to the original.
// The user now marks each model in ⚙️ Settings → Image API, and every model
// dropdown filters to the models marked for that job. The name heuristic
// survives only as the *default* for a model that has never been marked, so an
// existing config keeps working without anyone ticking 40 boxes first.
const IMAGE_MODEL_CAPABILITIES = ["generate", "edit", "combine", "upscale"];

const IMAGE_CAPABILITY_META = {
  generate: { icon: "🪄", label: "Generate", title: "Text-to-image — creates a new image from a prompt alone" },
  edit: { icon: "✨", label: "Edit", title: "Image-to-image — edits one source image from an instruction" },
  combine: { icon: "🔀", label: "Combine", title: "Accepts two or more reference images in a single call" },
  upscale: { icon: "⬆️", label: "Enhance", title: "Good at upscaling / cleaning up an image without changing its content" },
};

// Same markers _looksEditCapable used. Kept deliberately conservative: it only
// decides the starting state of the checkboxes, and being wrong is now a tick
// away from fixed rather than a mystery about why an edit did nothing.
const IMAGE_EDIT_NAME_MARKERS = ["image-to-image", "img2img", "-edit", "edit-", "/edit", "kontext", "inpaint", "instruct"];

// There is no equivalent naming convention for "accepts multiple reference
// images" — qwen-image-3-pro, reve/2.1/remix and xai/…/edit all support it with
// nothing in common in their names — so Combine defaults to off for everything
// and is purely a user decision.
//
// `apiModel` is the model's entry from the provider's model list, when there is
// one. nano-gpt's /image-models says which inputs each model takes, which beats
// guessing from the name: an edit model takes text + image, a text-to-image
// model text only, and a background remover or upscaler an image only.
function guessImageModelCapabilities(modelId, apiModel) {
  const id = (modelId || "").toLowerCase();
  // The proxy's local ComfyUI models are known exactly rather than guessed: the
  // proxy's /api/image/local-models says what each workflow does. Without that
  // entry (a model added by hand), Qwen-Image, MOSS-Image, FIBO, Klein and H3-Image
  // edit, and all but MOSS combine. Never Enhance: the proxy pins edit output to
  // COMFYUI_EDIT_MEGAPIXELS, so it can't return the larger image an upscale asks for.
  if (id.startsWith("local/")) {
    const local = apiModel?.local_capabilities
      || { generate: true, edit: /^local\/(qwen-image|moss-image|fibo|flux3-klein|minimax-h3-image)/.test(id), combine: /^local\/(qwen-image|fibo|flux3-klein|minimax-h3-image)/.test(id) };
    return { generate: !!local.generate, edit: !!local.edit, combine: !!local.combine, upscale: false };
  }
  const looksEdit = IMAGE_EDIT_NAME_MARKERS.some(marker => id.includes(marker));
  // Enhance is an image-to-image job, so anything edit-shaped is a fair
  // starting guess — how *well* a given model upscales is something only the
  // user can judge, which is exactly why it is a separate tickbox.
  const looksUpscale = looksEdit || ["upscal", "enhance", "restor", "super-res", "superres"].some(m => id.includes(m));
  const byName = { generate: !looksEdit, edit: looksEdit, combine: false, upscale: looksUpscale };

  const inputs = apiModel?.architecture?.input_modalities;
  const apiCaps = apiModel?.capabilities;
  if (!Array.isArray(inputs) && !apiCaps) return byName;
  const takesText = Array.isArray(inputs) ? inputs.includes("text") : true;
  const takesImage = !!apiCaps?.image_to_image || (Array.isArray(inputs) && inputs.includes("image"));
  return {
    // Plenty of text+image models (seedream, hidream) also generate from text
    // alone, so an image input only rules out Generate when the name says edit.
    generate: takesText && (!takesImage || !looksEdit),
    edit: takesText && takesImage,
    combine: false,
    upscale: takesImage && looksUpscale,
  };
}

// The stored marks for one model, falling back to the name guess. Model ids
// contain dots and slashes (`reve/2.1/remix`), so the map is read whole and
// indexed — never via config.get("api.image.modelCapabilities." + id), which
// would split the id on its own dots.
function getImageModelCapabilities(modelId, configInstance, apiModel) {
  const cfg = configInstance || window.config;
  const stored = (cfg?.get("api.image.modelCapabilities") || {})[modelId];
  const guess = guessImageModelCapabilities(modelId, apiModel);
  if (!stored) return guess;
  // Merge rather than replace: a capability added to the app after this model
  // was marked has no stored value and should still get its guessed default.
  return IMAGE_MODEL_CAPABILITIES.reduce((out, cap) => {
    out[cap] = typeof stored[cap] === "boolean" ? stored[cap] : guess[cap];
    return out;
  }, {});
}

// Every model marked as able to do `capability`, in the order they appear in
// the user's model list.
function getImageModelsWithCapability(capability, configInstance) {
  const cfg = configInstance || window.config;
  const models = cfg?.get("api.image.models") || [];
  return models.filter(model => getImageModelCapabilities(model, cfg)[capability]);
}

// The model to reach for when a job needs one and there's no dropdown to ask —
// Roleplay's "visualize this scene" and the auto-defaults applied to a brand-new
// character all just took models[0] before, which silently picked an
// image-to-image model for a text-to-image job if that happened to be first in
// the list. Falls back to the first model overall so an unmarked config still
// generates something rather than nothing.
function firstImageModelWithCapability(capability, configInstance) {
  const cfg = configInstance || window.config;
  const matching = getImageModelsWithCapability(capability, cfg);
  if (matching.length > 0) return matching[0];
  return (cfg?.get("api.image.models") || [])[0] || "";
}

// Models served by ComfyUI on the owner's own PC (LOCAL_COMFY_MODELS in
// proxy/server.js). They are unavailable whenever that PC is off.
function isLocalImageModel(model) {
  return String(model || "").startsWith("local/");
}
