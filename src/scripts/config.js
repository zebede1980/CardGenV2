// Configuration file for SillyTavern Character Generator
const LOCAL_STORAGE_KEY = "charGeneratorConfig";

// ── Image-model capabilities ────────────────────────────────────────────────
// Which of the three image jobs a given model can actually do. Providers don't
// report this — nano-gpt's model list returns bare ids with no capability
// field — so the app used to guess from the name alone (_looksEditCapable in
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
const IMAGE_EDIT_NAME_MARKERS = ["image-to-image", "img2img", "-edit", "edit-", "kontext", "inpaint", "instruct"];

// There is no equivalent naming convention for "accepts multiple reference
// images" — qwen-image-3-pro, reve/2.1/remix and xai/…/edit all support it with
// nothing in common in their names — so Combine defaults to off for everything
// and is purely a user decision.
function guessImageModelCapabilities(modelId) {
  const id = (modelId || "").toLowerCase();
  const looksEdit = IMAGE_EDIT_NAME_MARKERS.some(marker => id.includes(marker));
  // Enhance is an image-to-image job, so anything edit-shaped is a fair
  // starting guess — how *well* a given model upscales is something only the
  // user can judge, which is exactly why it is a separate tickbox.
  const looksUpscale = looksEdit || ["upscal", "enhance", "restor", "super-res", "superres"].some(m => id.includes(m));
  return { generate: !looksEdit, edit: looksEdit, combine: false, upscale: looksUpscale };
}

// The stored marks for one model, falling back to the name guess. Model ids
// contain dots and slashes (`reve/2.1/remix`), so the map is read whole and
// indexed — never via config.get("api.image.modelCapabilities." + id), which
// would split the id on its own dots.
function getImageModelCapabilities(modelId, configInstance) {
  const cfg = configInstance || window.config;
  const stored = (cfg?.get("api.image.modelCapabilities") || {})[modelId];
  if (!stored) return guessImageModelCapabilities(modelId);
  const guess = guessImageModelCapabilities(modelId);
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

// The "nothing is marked for this job" note shown under a filtered dropdown.
// Shared so the Character Generator, the Playground and anything added later
// explain an unfiltered list the same way.
function renderImageModelHint(hintEl, capability, result, configInstance) {
  if (!hintEl) return;
  const cfg = configInstance || window.config;
  const meta = IMAGE_CAPABILITY_META[capability];
  const total = (cfg?.get("api.image.models") || []).length;

  if (total === 0) {
    hintEl.style.display = "block";
    hintEl.textContent = "No image models configured yet — add some in ⚙️ Settings → Image API.";
  } else if (!result.filtered) {
    hintEl.style.display = "block";
    hintEl.textContent = `No model is marked ${meta.icon} ${meta.label} yet, so all of them are listed. Tick ${meta.icon} next to the right models in ⚙️ Settings → Image API → Available Image Models.`;
  } else {
    hintEl.style.display = "none";
  }
}

// ── Per-model cost and speed ────────────────────────────────────────────────
// How long a model takes varies enormously (seconds to minutes) and so does
// what it costs, but neither is discoverable from the provider's model list.
// Speed is therefore measured from actual runs — a rolling mean per model,
// recorded by api-image.js after every successful call — and cost is a short
// note the user types once in Settings, since only they can see their billing.
// Both surface in the model dropdowns, where the choice is actually made.

function recordImageModelRun(modelId, elapsedMs, configInstance) {
  const cfg = configInstance || window.config;
  if (!cfg || !modelId || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;

  const stats = { ...(cfg.get("api.image.modelStats") || {}) };
  const previous = stats[modelId] || { runs: 0, avgMs: 0 };
  const runs = previous.runs + 1;
  // Mean over the last few runs rather than all time: a model's speed changes
  // with provider load, and a number from fifty runs ago is not what the next
  // call will cost in time. Weighting the newest run at 1/min(runs, 10) settles
  // quickly and then tracks recent behaviour.
  const weight = 1 / Math.min(runs, 10);
  stats[modelId] = {
    runs,
    avgMs: Math.round(previous.avgMs + (elapsedMs - previous.avgMs) * weight),
    lastMs: Math.round(elapsedMs),
  };
  cfg.set("api.image.modelStats", stats);
}

// "~18s · $0.04", or "" when nothing is known yet. Deliberately terse — it is
// appended to an <option> label, which has very little room on a phone.
function describeImageModelCostSpeed(modelId, configInstance) {
  const cfg = configInstance || window.config;
  const parts = [];

  const stat = (cfg?.get("api.image.modelStats") || {})[modelId];
  if (stat?.avgMs > 0) {
    const seconds = stat.avgMs / 1000;
    parts.push(seconds >= 60 ? `~${Math.round(seconds / 6) / 10}min` : `~${Math.round(seconds)}s`);
  }

  const costNote = (cfg?.get("api.image.modelSettings") || {})[modelId]?.costNote;
  if (costNote) parts.push(String(costNote).trim().slice(0, 20));

  return parts.join(" · ");
}

// Fills a <select> with just the models marked for one job. Shared by the
// Playground's three model dropdowns and Settings' "Image Edit Model", so the
// same list and the same explanation of an empty list appear everywhere.
//
// Falls back to listing every model (each flagged) rather than showing an empty
// dropdown when nothing is marked: an unmarked config must never leave a tool
// unusable, and Combine in particular has no name heuristic to seed itself from
// so it starts out with nothing marked at all.
// `configKey` is both read (to pre-select) and written back when the stored
// model isn't in the list at all and the dropdown has to fall back to another.
// The write-back matters because not every consumer reads the dropdown: the
// Character Generator's Edit Image and the Character Gallery both read
// api.image.editModel straight from config, so a dropdown that silently showed
// one model while config held another would edit with the wrong one.
function populateImageModelSelect(selectEl, capability, configKey, configInstance, options = {}) {
  if (!selectEl) return { count: 0, filtered: false };

  const cfg = configInstance || window.config;
  const currentValue = cfg?.get(configKey) || "";
  const allModels = cfg?.get("api.image.models") || [];
  const meta = IMAGE_CAPABILITY_META[capability];

  if (allModels.length === 0) {
    // `emptyOptionLabel` keeps an empty value meaningful for the Character
    // Generator, where "" means "let the image API pick its own default" — the
    // Playground's dropdowns have no such notion and just explain themselves.
    if (options.emptyOptionLabel) {
      selectEl.innerHTML = `<option value="">${escapeHtml(options.emptyOptionLabel)}</option>`;
      if (currentValue) {
        selectEl.innerHTML += `<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}</option>`;
      }
    } else {
      selectEl.innerHTML = `<option value="${escapeHtml(currentValue)}">${escapeHtml(currentValue || "No models configured — add one in ⚙️ Settings → Image API")}</option>`;
    }
    return { count: 0, filtered: false };
  }

  const matching = getImageModelsWithCapability(capability, cfg);
  const filtered = matching.length > 0;
  let listed = filtered ? matching : allModels;

  // A model already saved for this job stays selectable even if it isn't
  // marked for it — changing the user's stored model out from under them
  // because of a checkbox default would be worse than showing it with a flag.
  if (currentValue && !listed.includes(currentValue)) listed = [currentValue, ...listed];

  selectEl.innerHTML = listed
    .map(model => {
      const marked = getImageModelCapabilities(model, cfg)[capability];
      const costSpeed = describeImageModelCostSpeed(model, cfg);
      let label = marked ? model : `${model} ⚠️ not marked as ${meta.label}`;
      if (costSpeed) label += ` · ${costSpeed}`;
      return `<option value="${escapeHtml(model)}" ${model === currentValue ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");

  if (!listed.includes(currentValue)) {
    selectEl.value = listed[0];
    if (cfg && selectEl.value) cfg.set(configKey, selectEl.value);
  }
  return { count: matching.length, filtered };
}

// One row of ⚙️ Settings → Image API → Available Image Models. Built here
// rather than inline at each call site because three separate places render
// this row — saveToForm below, handleFetchImageModels (image-handler.js) and
// the manual "Add" button (main.js) — and they drifted apart before.
function renderImageModelRow(modelId, isChecked, configInstance) {
  const caps = getImageModelCapabilities(modelId, configInstance);
  const capBoxes = IMAGE_MODEL_CAPABILITIES.map(cap => {
    const meta = IMAGE_CAPABILITY_META[cap];
    return `
      <label title="${escapeHtml(meta.title)}" style="display:flex;align-items:center;gap:0.2rem;cursor:pointer;font-size:0.75rem;color:var(--text-secondary);">
        <input type="checkbox" class="image-model-cap-checkbox" data-model="${escapeHtml(modelId)}" data-cap="${cap}" ${caps[cap] ? "checked" : ""}>
        ${meta.icon}
      </label>`;
  }).join("");

  return `
    <div class="image-model-row" data-model="${escapeHtml(modelId)}" style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:0.5rem;flex:1 1 8rem;min-width:0;cursor:pointer;word-break:break-all;">
        <input type="checkbox" class="image-model-checkbox" value="${escapeHtml(modelId)}" ${isChecked ? "checked" : ""}>
        ${escapeHtml(modelId)}
      </label>
      <span class="image-model-caps" style="display:flex;align-items:center;gap:0.5rem;flex:0 0 auto;">${capBoxes}</span>
      <button type="button" class="image-model-delete-btn" data-model="${escapeHtml(modelId)}" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:0 0.25rem;font-size:1rem;line-height:1;">&times;</button>
    </div>`;
}

class Config {
  constructor() {
    this.config = this.getDefaultConfig();
    this.debugMode = false; // Toggle for verbose logging
    this.isLoaded = false;
    this.loadPromise = this.loadConfig().catch((e) => {
      console.error(e);
      this.isLoaded = true;
    });
  }

  getDefaultConfig() {
    return {
      api: {
        text: {
          baseUrl: "",
          apiKey: "",
          model: "",
          visionModel: "",
          timeout: 180000,
        },
        image: {
          baseUrl: "",
          apiKey: "",
          model: "",
          models: [],
          size: "",
          style: "",
          aspectRatio: "",
          modelSettings: {},
          // modelId -> { generate, edit, combine }. Absent means "never
          // marked" — getImageModelCapabilities falls back to the name guess.
          modelCapabilities: {},
          upscaleModel: "",
          // Reusable Playground prompts the user has saved:
          // [{ id, tool, name, text }]. The built-in ones are code, not config.
          promptPresets: [],
          // modelId -> { runs, avgMs, lastMs }, measured from real calls.
          modelStats: {},
          timeout: 180000,
          localForge: {
            enabled: false,
            url: "http://127.0.0.1:7860",
          },
        },
        tts: {
          provider: "local",
          apiKey: "",
        },
      },
      app: {
        maxRetries: 3,
        retryDelay: 1000,
        debugMode: false,
        enableImageGeneration: true,
        creator: "",
      },
      st: {
        baseUrl: "",
        username: "",
        password: "",
      },
      chat: {
        maxInputTokens: 8192,
        maxOutputTokens: 1024,
        temperature: 0.8,
        repetitionPenalty: 1.0,
        filterCJK: false,
        systemPromptSegments: [
          "Stay in character at all times. Respond as your character.",
          "Write actions in *italics* and speech in \"quotes\".",
          "Do not narrate the user's actions or speak for the user.",
          "Do not break character or refer to yourself as an AI model.",
          "Respond exclusively in English. Do not output any Chinese or Korean characters."
        ]
      },
    };
  }

  // Toggle debug mode for verbose logging
  setDebugMode(enabled) {
    this.debugMode = enabled;
    this.config.app.debugMode = enabled;
    this.saveConfig();
    console.log(`Debug mode ${enabled ? "enabled" : "disabled"}`);
  }

  getDebugMode() {
    return this.debugMode || this.config.app.debugMode || false;
  }

  log(...args) {
    if (this.getDebugMode()) {
      console.log(...args);
    }
  }

  async loadConfig() {
    // Load from local storage first so it's available immediately
    const savedConfig = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedConfig) {
      try {
        const saved = JSON.parse(savedConfig);
        this.config = this.deepMerge(this.config, saved);
        this.logRedacted("Loaded config from storage:", saved);
      } catch (error) {
        console.warn("Failed to load saved config:", error);
      }
    }

    // Then sync/override with server config if available
    try {
      // Skip if no auth token yet — authFetch would get a 401 and
      // could disrupt the login flow. Config is reloaded after login.
      if (!(window.cardgenAuth && window.cardgenAuth.getToken())) {
        this.debugMode = this.config.app.debugMode || false;
        this.isLoaded = true;
        return;
      }
      const res = await (window.authFetch || fetch)("/api/config");
      if (res.ok) {
        const serverConfig = await res.json();
        if (Object.keys(serverConfig).length > 0) {
          this.config = this.deepMerge(this.config, serverConfig);
          this.logRedacted("Loaded config from server:", serverConfig);
        }
      }
    } catch (error) {
      console.warn("Failed to load config from server:", error);
    }

    // Load debug mode setting
    this.debugMode = this.config.app.debugMode || false;

    this.logRedacted("Final config:", this.config);
    this.isLoaded = true;
  }

  loadFromForm() {
    // Load text API settings from form
    const textBaseUrl = document.getElementById("text-api-base")?.value?.trim();
    const textApiKey = document.getElementById("text-api-key")?.value?.trim();
    const textModel = document.getElementById("text-model")?.value?.trim();
    const visionModel = document.getElementById("vision-model")?.value?.trim();

    if (textBaseUrl !== undefined) this.config.api.text.baseUrl = textBaseUrl;
    if (textApiKey !== undefined) this.config.api.text.apiKey = textApiKey;
    if (textModel !== undefined) this.config.api.text.model = textModel;
    if (visionModel !== undefined)
      this.config.api.text.visionModel = visionModel;

    // No special handling needed when using proxy server

    // Load image API settings from form
    const imageBaseUrl = document.getElementById("image-api-base")?.value?.trim();
    const imageApiKey = document.getElementById("image-api-key")?.value?.trim();
    const imageSize = document.getElementById("image-size")?.value?.trim();
    const imageEditModel = document.getElementById("image-edit-model")?.value?.trim();
    const imageSteps = document.getElementById("image-steps")?.value?.trim();
    const imageCfgScale = document.getElementById("image-cfg-scale")?.value?.trim();
    const imagePromptLengthPref = document.getElementById("image-prompt-length-pref")?.value;
    const imageIsFlux = document.getElementById("image-is-flux")?.checked;
    const imageCostNote = document.getElementById("image-cost-note")?.value?.trim();
    const imageModelSettingsSelector = document.getElementById("model-settings-selector")?.value;
    const imageStyle = document.getElementById("image-style")?.value;
    const imageMood = document.getElementById("image-mood")?.value;
    const customImageStyle = document.getElementById("custom-image-style-input")?.value;
    const imageAspectRatio = document.getElementById("image-aspect-ratio")?.value;
    
    const imageModelCheckboxes = document.querySelectorAll(".image-model-checkbox:checked");
    this.config.api.image.models = Array.from(imageModelCheckboxes).map(cb => cb.value);

    // Per-model capability marks. Merged into whatever is already stored, not
    // replaced: after "Fetch from API" the container lists the provider's whole
    // catalogue, but a model the user added by hand and has since filtered out
    // of view still has marks worth keeping. Only rows actually on screen are
    // touched — if the container has never been rendered there are no rows and
    // nothing is overwritten.
    const capCheckboxes = document.querySelectorAll(".image-model-cap-checkbox");
    if (capCheckboxes.length > 0) {
      const capabilities = { ...(this.config.api.image.modelCapabilities || {}) };
      capCheckboxes.forEach(cb => {
        const modelId = cb.dataset.model;
        const capability = cb.dataset.cap;
        if (!modelId || !IMAGE_MODEL_CAPABILITIES.includes(capability)) return;
        if (!capabilities[modelId]) capabilities[modelId] = {};
        capabilities[modelId][capability] = cb.checked;
      });
      // Pruned to the selected models. After "Fetch from API" the container
      // lists the provider's entire catalogue — a hundred-odd rows for
      // nano-gpt — and without this every one of them would be written into
      // the config and POSTed to the server, when the only models any dropdown
      // ever draws from are the selected ones.
      const selected = new Set(this.config.api.image.models);
      this.config.api.image.modelCapabilities = Object.fromEntries(
        Object.entries(capabilities).filter(([modelId]) => selected.has(modelId)),
      );
    }

    if (imageBaseUrl !== undefined)
      this.config.api.image.baseUrl = imageBaseUrl;
    if (imageApiKey !== undefined) this.config.api.image.apiKey = imageApiKey;
    if (imageSize !== undefined) this.config.api.image.size = imageSize;
    if (imageEditModel !== undefined) this.config.api.image.editModel = imageEditModel;
    
    if (imageModelSettingsSelector) {
        if (!this.config.api.image.modelSettings) this.config.api.image.modelSettings = {};
        this.config.api.image.modelSettings[imageModelSettingsSelector] = {
            steps: imageSteps !== undefined ? imageSteps : "",
            cfgScale: imageCfgScale !== undefined ? imageCfgScale : "",
            promptLengthPref: imagePromptLengthPref !== undefined ? imagePromptLengthPref : "detailed",
            isFlux: imageIsFlux !== undefined ? imageIsFlux : false,
            costNote: imageCostNote !== undefined ? imageCostNote : ""
        };
    }
    if (imageStyle !== undefined) this.config.api.image.style = imageStyle;
    if (imageMood !== undefined) this.config.api.image.mood = imageMood;
    if (customImageStyle !== undefined) this.config.api.image.customStyleText = customImageStyle;
    if (imageAspectRatio !== undefined) this.config.api.image.aspectRatio = imageAspectRatio;

    // Load toggle states
    const enableImageGeneration = document.getElementById(
      "enable-image-generation",
    )?.checked;
    if (enableImageGeneration !== undefined)
      this.config.app.enableImageGeneration = enableImageGeneration;

    // Load Local Forge settings
    const forgeUrl = document.getElementById("local-forge-url")?.value?.trim();
    const forgeEnabled = document.getElementById("local-forge-enabled")?.checked;
    if (!this.config.api.image.localForge) this.config.api.image.localForge = {};
    if (forgeUrl !== undefined) this.config.api.image.localForge.url = forgeUrl || "http://127.0.0.1:7860";
    if (forgeEnabled !== undefined) this.config.api.image.localForge.enabled = forgeEnabled;

    // Load creator setting
    const creator = document.getElementById("creator-name")?.value?.trim();
    if (creator !== undefined) this.config.app.creator = creator;

    // Load SillyTavern settings
    const stBaseUrl = document.getElementById("st-base-url")?.value?.trim();
    const stUsername = document.getElementById("st-username")?.value?.trim();
    const stPassword = document.getElementById("st-password")?.value;
    if (stBaseUrl !== undefined || stUsername !== undefined || stPassword !== undefined) {
      if (!this.config.st) this.config.st = {};
      if (stBaseUrl !== undefined) this.config.st.baseUrl = stBaseUrl;
      if (stUsername !== undefined) this.config.st.username = stUsername;
      if (stPassword !== undefined) this.config.st.password = stPassword;
    }
  }

  get(path) {
    return path.split(".").reduce((obj, key) => obj && obj[key], this.config);
  }

  set(path, value) {
    const keys = path.split(".");
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => {
      if (!obj[key]) obj[key] = {};
      return obj[key];
    }, this.config);
    target[lastKey] = value;
    this.saveConfig();
  }

  saveConfig() {
    if (!this.isLoaded) {
      console.warn("Attempted to save config before it was fully loaded. Ignoring save to prevent data loss.");
      return;
    }

    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(this.config));

    // Also save to server for persistence across devices/sessions
    (window.authFetch || fetch)("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.config)
    }).catch(e => console.error("Failed to sync config to server", e));
  }

  saveToForm() {
    // Save text API to form
    const textBaseUrl = document.getElementById("text-api-base");
    const textApiKey = document.getElementById("text-api-key");
    const textModel = document.getElementById("text-model");
    const visionModel = document.getElementById("vision-model");

    if (textBaseUrl) textBaseUrl.value = this.config.api.text.baseUrl || "";
    if (textApiKey) textApiKey.value = this.config.api.text.apiKey || "";
    if (textModel) textModel.value = this.config.api.text.model || "";
    if (visionModel)
      visionModel.value = this.config.api.text.visionModel || "";

    // Save image API to form
    const imageBaseUrl = document.getElementById("image-api-base");
    const imageApiKey = document.getElementById("image-api-key");
    const imageSize = document.getElementById("image-size");
    const imageEditModel = document.getElementById("image-edit-model");
    const imageStyle = document.getElementById("image-style");
    const imageMood = document.getElementById("image-mood");
    const customImageStyle = document.getElementById("custom-image-style-input");
    const customStyleContainer = document.getElementById("custom-style-container");
    const imageAspectRatio = document.getElementById("image-aspect-ratio");

    if (imageBaseUrl)
      imageBaseUrl.value = this.config.api.image.baseUrl || "";
    if (imageApiKey) imageApiKey.value = this.config.api.image.apiKey || "";
    if (imageSize) imageSize.value = this.config.api.image.size || "";
    // A dropdown of edit-marked models rather than the free-text box it used to
    // be — the model list is the single source of truth now, and a typo here
    // used to surface as an opaque API error at edit time. Anything not in the
    // list can still be added via "Available Image Models" → Add.
    if (imageEditModel) populateImageModelSelect(imageEditModel, "edit", "api.image.editModel", this);
    if (imageStyle) {
        imageStyle.value = this.config.api.image.style || "";
        if (customStyleContainer) customStyleContainer.style.display = imageStyle.value === "custom" ? "block" : "none";
    }
    if (imageMood) imageMood.value = this.config.api.image.mood || "";
    if (customImageStyle) customImageStyle.value = this.config.api.image.customStyleText || "";
    if (imageAspectRatio) imageAspectRatio.value = this.config.api.image.aspectRatio || "";

    // Save creator to form
    const creatorName = document.getElementById("creator-name");
    if (creatorName) creatorName.value = this.config.app.creator || "";

    // Save SillyTavern settings to form
    const stBaseUrl = document.getElementById("st-base-url");
    if (stBaseUrl) stBaseUrl.value = this.config.st?.baseUrl || "";
    const stUsername = document.getElementById("st-username");
    if (stUsername) stUsername.value = this.config.st?.username || "";
    const stPassword = document.getElementById("st-password");
    if (stPassword) stPassword.value = this.config.st?.password || "";
    
    const imageModelsContainer = document.getElementById("image-models-container");
    if (imageModelsContainer) {
        if (this.config.api.image.models && this.config.api.image.models.length > 0) {
            imageModelsContainer.innerHTML = this.config.api.image.models
                .map(model => renderImageModelRow(model, true, this))
                .join('');
        } else {
            imageModelsContainer.innerHTML = '<p style="font-size: 0.8rem; color: var(--text-secondary); margin: 0;">Click \'Fetch Models\' to load available models.</p>';
        }
    }
    
    // Update model-settings-selector
    const modelSettingsSelector = document.getElementById("model-settings-selector");
    const modelSettingsContainer = document.getElementById("model-specific-settings");
    if (modelSettingsSelector && modelSettingsContainer) {
        const currentSelection = modelSettingsSelector.value;
        const models = this.config.api.image.models || [];
        
        if (models.length > 0) {
            modelSettingsSelector.innerHTML = '<option value="">Select a model to configure...</option>' + 
                models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
            
            if (models.includes(currentSelection)) {
                modelSettingsSelector.value = currentSelection;
            } else {
                modelSettingsSelector.value = models[0];
            }
            modelSettingsContainer.style.display = "block";
        } else {
            modelSettingsSelector.innerHTML = '<option value="">Select a model to configure...</option>';
            modelSettingsSelector.value = "";
            modelSettingsContainer.style.display = "none";
        }
        
        // Populate inputs based on selection
        const selected = modelSettingsSelector.value;
        const imageSteps = document.getElementById("image-steps");
        const imageCfgScale = document.getElementById("image-cfg-scale");
        const imagePromptLengthPref = document.getElementById("image-prompt-length-pref");
        const imageIsFlux = document.getElementById("image-is-flux");
        const imageCostNote = document.getElementById("image-cost-note");
        
        if (selected && this.config.api.image.modelSettings && this.config.api.image.modelSettings[selected]) {
            const settings = this.config.api.image.modelSettings[selected];
            if (imageSteps) imageSteps.value = settings.steps || "";
            if (imageCfgScale) imageCfgScale.value = settings.cfgScale || "";
            if (imagePromptLengthPref) imagePromptLengthPref.value = settings.promptLengthPref || "detailed";
            if (imageIsFlux) imageIsFlux.checked = settings.isFlux || false;
            if (imageCostNote) imageCostNote.value = settings.costNote || "";
        } else {
            if (imageSteps) imageSteps.value = "";
            if (imageCfgScale) imageCfgScale.value = "";
            if (imagePromptLengthPref) imagePromptLengthPref.value = "detailed";
            if (imageIsFlux) imageIsFlux.checked = false;
            if (imageCostNote) imageCostNote.value = "";
        }
    }
    
    // Update main UI dropdown
    if (window.app && typeof window.app.updateActiveModelsDropdown === 'function') {
        window.app.updateActiveModelsDropdown();
    }

    // Save toggle states
    const enableImageGeneration = document.getElementById(
      "enable-image-generation",
    );
    if (enableImageGeneration)
      enableImageGeneration.checked =
        this.config.app.enableImageGeneration !== false;

    // Save Local Forge settings to form
    const forgeUrlEl = document.getElementById("local-forge-url");
    if (forgeUrlEl) forgeUrlEl.value = this.config.api.image.localForge?.url || "http://127.0.0.1:7860";
    const forgeEnabledEl = document.getElementById("local-forge-enabled");
    if (forgeEnabledEl) forgeEnabledEl.checked = this.config.api.image.localForge?.enabled || false;
    // Sync the visual toggle state
    const forgeToggleContainer = document.getElementById("local-forge-url-container");
    if (forgeToggleContainer) forgeToggleContainer.style.display = forgeEnabledEl?.checked ? "block" : "none";
  }

  deepMerge(target, source) {
    const output = { ...target };
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  isObject(item) {
    return item && typeof item === "object" && !Array.isArray(item);
  }

  async waitForConfig() {
    if (this.loadPromise) {
      await this.loadPromise;
    }
    return this.config;
  }

  validateConfig() {
    const errors = [];

    // Text API validation
    if (!this.config.api.text.baseUrl) {
      errors.push("Text API base URL is required");
    }
    if (!this.config.api.text.apiKey) {
      errors.push("Text API key is required");
    }
    if (!this.config.api.text.model) {
      errors.push("Text model is required");
    }

    return errors;
  }

  clearStoredConfig() {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    if (window.cardgenAuth && window.cardgenAuth.getToken()) {
      (window.authFetch || fetch)("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      }).catch(e => console.error("Failed to clear config on server", e));
    }
  }

  redactSensitiveData(data) {
    if (Array.isArray(data)) {
      return data.map((item) => this.redactSensitiveData(item));
    }

    if (!this.isObject(data)) {
      return data;
    }

    const redacted = {};
    Object.keys(data).forEach((key) => {
      if (key.toLowerCase().includes("apikey")) {
        redacted[key] = data[key] ? "[REDACTED]" : "";
      } else {
        redacted[key] = this.redactSensitiveData(data[key]);
      }
    });
    return redacted;
  }

  logRedacted(message, data) {
    if (this.getDebugMode()) {
      console.log(message, this.redactSensitiveData(data));
    }
  }

  updateStorageMethod() {
    // When changing persistence setting, migrate keys between storage methods
    if (this.config.app.persistApiKeys) {
      // Move from sessionStorage to localStorage
      const textKey = this.getSessionValue(SESSION_STORAGE_KEYS.textApiKey);
      const imageKey = this.getSessionValue(SESSION_STORAGE_KEYS.imageApiKey);

      if (textKey) {
        this.persistLocalStorageValue(SESSION_STORAGE_KEYS.textApiKey, textKey);
        sessionStorage.removeItem(SESSION_STORAGE_KEYS.textApiKey);
      }
      if (imageKey) {
        this.persistLocalStorageValue(
          SESSION_STORAGE_KEYS.imageApiKey,
          imageKey,
        );
        sessionStorage.removeItem(SESSION_STORAGE_KEYS.imageApiKey);
      }
    } else {
      // Move from localStorage to sessionStorage
      const textKey = this.getLocalStorageValue(
        SESSION_STORAGE_KEYS.textApiKey,
      );
      const imageKey = this.getLocalStorageValue(
        SESSION_STORAGE_KEYS.imageApiKey,
      );

      if (textKey) {
        this.persistSessionValue(SESSION_STORAGE_KEYS.textApiKey, textKey);
        localStorage.removeItem(SESSION_STORAGE_KEYS.textApiKey);
      }
      if (imageKey) {
        this.persistSessionValue(SESSION_STORAGE_KEYS.imageApiKey, imageKey);
        localStorage.removeItem(SESSION_STORAGE_KEYS.imageApiKey);
      }
    }
  }
}

// Export singleton instance
window.config = new Config();
