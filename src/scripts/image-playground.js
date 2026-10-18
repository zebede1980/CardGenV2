// Image Playground — a standalone image-editing workspace with no card or
// character concept involved. Reuses the same crop/edit tooling already
// generalized for the reference-image section (see image-cropper.js,
// image-handler.js's handleEditReferenceImage) via a third 'playground'
// target, working on this.playgroundImageUrl instead of a card's portrait or
// the pre-generation reference image.

// Uploaded/pasted Playground images are resized to this before use. 2048px
// keeps the detail edits and Enhance need; JPEG keeps a Combine request (two
// images, base64'd) inside nginx's 12MB body limit.
const PLAYGROUND_IMAGE_ENCODING = { maxSide: 2048, quality: 0.92 };
// Prompt presets. The built-ins ship with the app and cannot be deleted — they
// exist so the feature is useful the first time it is opened rather than after
// the user has curated a list. Anything the user saves lives in config under
// api.image.promptPresets and is listed alongside them.
const PLAYGROUND_BUILTIN_PRESETS = {
  generate: [
    { name: "Portrait, photoreal", text: "a photorealistic portrait, natural lighting, shallow depth of field, sharp focus on the eyes" },
    { name: "Character, painted", text: "digital painting of a character, full body, dramatic lighting, detailed rendering, fantasy art style" },
    { name: "Scene, cinematic", text: "a cinematic wide shot, volumetric lighting, film grain, moody colour grading" },
  ],
  edit: [
    { name: "Remove the background", text: "remove the background completely, leave the subject on a plain neutral background, keep the subject unchanged" },
    { name: "Convert to photoreal", text: "convert this into a realistic photograph, same character, same pose, same outfit, photographic lighting and skin texture" },
    { name: "Change the outfit", text: "change the outfit to <describe it here>, keep the face, hair, pose and background exactly the same" },
    { name: "Change the setting", text: "place the same character in <describe the setting>, keep the character's face, hair and outfit exactly the same" },
    { name: "Clean up / restore", text: "clean up this image: remove artefacts and noise, sharpen detail, correct the colours, change nothing else" },
  ],
  combine: [
    { name: "Outfit from image 2", text: "put the outfit from Image 2 onto the character in Image 1, keeping the face, hair and pose from Image 1" },
    { name: "Both characters together", text: "combine both characters into a single group shot, consistent lighting and art style" },
    { name: "Style of image 2", text: "redraw Image 1 in the art style of Image 2, keeping the subject and composition of Image 1" },
  ],
};

Object.assign(CharacterGeneratorApp.prototype, {

  initPlaygroundTab() {
    const tabPlayground = document.getElementById("tab-playground");
    const viewPlayground = document.getElementById("view-playground");
    if (!tabPlayground || !viewPlayground) return;

    // All other top-level tabs/views known at the time this file loads.
    // Self-contained on purpose: rather than editing chat-handler.js /
    // storywriter.js / adventure-handler.js to teach them about this new
    // tab, this attaches its own show/hide listeners to their existing
    // buttons — the same non-invasive approach chat-handler.js used when it
    // was added alongside the original two tabs.
    // Includes tab-home/view-home (injected at runtime by home-handler.js,
    // which post-dates this file and never knew to hide/be-hidden-by
    // Playground) — without it, Home stays visible underneath Playground on
    // the very first switch from a fresh load, and switching back to Home
    // from Playground leaves Playground visible underneath it too.
    const otherTabs = ["tab-home", "tab-cardgen", "tab-storywriter", "tab-roleplaychat", "tab-adventure"]
      .map(id => document.getElementById(id))
      .filter(Boolean);
    const otherViews = ["view-home", "view-cardgen", "view-storywriter", "view-roleplaychat", "view-adventure"]
      .map(id => document.getElementById(id))
      .filter(Boolean);

    tabPlayground.addEventListener("click", () => {
      otherViews.forEach(v => { v.style.display = "none"; });
      otherTabs.forEach(b => { b.className = "btn-outline"; });
      const resultSection = document.querySelector(".result-section");
      if (resultSection) resultSection.style.display = "none";

      viewPlayground.style.display = "block";
      tabPlayground.className = "btn-primary";
      document.body.classList.remove("chat-active", "chat-in-chat");
      // Refreshed on every tab-open (not just once at init) so a model/
      // provider changed in Settings while on another tab shows up
      // immediately.
      this._updatePlaygroundGenerateModelDropdown();
      this._updatePlaygroundEditModelDropdown();
      this._updatePlaygroundCombineModelDropdown();
      this._updatePlaygroundUpscaleModelDropdown();
      this._restorePlaygroundGenerateCount();
      this._restorePlaygroundGenerateRatio();
    });

    otherTabs.forEach(btn => {
      btn.addEventListener("click", () => {
        viewPlayground.style.display = "none";
        tabPlayground.className = "btn-outline";
      });
    });

    // Image upload / paste
    const fileInput = document.getElementById("playground-image-file");
    if (fileInput) {
      fileInput.addEventListener("change", (e) => this.handlePlaygroundImageUpload(e));
    }
    // The drop zone doubles as click-to-upload (opens the hidden file input)
    // and as the paste target. It has to stay contenteditable rather than a
    // plain <button> because iOS only shows its native "Paste" action on a
    // focusable, editable element.
    const dropZone = document.getElementById("playground-drop-zone");
    if (dropZone && fileInput) {
      dropZone.addEventListener("click", () => fileInput.click());
    }
    // Bound directly on the zone itself (not document) so a paste only ever
    // lands here when this exact field is focused — each paste zone on the
    // page owns its own listener now, see handleReferenceImagePaste in
    // main.js and the Gallery instruction boxes in character-gallery-panel.js
    // for the equivalent scoping there. Requires clicking/tapping the zone
    // first, same as it already took to get iOS's native Paste bubble to
    // show via _initPasteZoneAutoSelect.
    if (dropZone) dropZone.addEventListener("paste", (e) => this.handlePlaygroundImagePaste(e));

    // Image 2 upload / paste (Combine tab)
    const combineImage2Input = document.getElementById("combine-image2-file");
    if (combineImage2Input) {
      combineImage2Input.addEventListener("change", (e) => this.handleCombineImage2Upload(e));
    }
    const combineImage2Zone = document.getElementById("combine-image2-paste-zone");
    if (combineImage2Zone && combineImage2Input) {
      combineImage2Zone.addEventListener("click", () => combineImage2Input.click());
      combineImage2Zone.addEventListener("paste", (e) => this.handleCombineImage2Paste(e));
    }

    // Tool tabs (Generate / Crop / Edit / Combine) — only one panel on
    // screen at a time. Crop embeds the same shared crop modal tool used
    // elsewhere in the app (see _relocateCropModal), opened the moment its
    // tab is selected. In-fill/Consistency/Expand tabs were cut in favor of
    // just using Edit with a good image-to-image model. Generate is the only
    // tab that doesn't require an existing working image — it's how one gets
    // created from nothing but a prompt.
    ["generate", "crop", "edit", "enhance", "combine", "library"].forEach(tab => {
      const btn = document.getElementById(`pg-tab-${tab}`);
      if (btn) btn.addEventListener("click", () => this._setPlaygroundToolTab(tab));
    });
    // Reflects the HTML's default active tab (Generate) in _pgActiveTab so
    // the first tab switch after load behaves consistently with any other.
    this._setPlaygroundToolTab("generate");

    const generateModelSelect = document.getElementById("playground-generate-model");
    if (generateModelSelect) {
      generateModelSelect.addEventListener("change", (e) => this.config.set("api.image.generateModel", e.target.value));
    }
    const generateBtn = document.getElementById("generate-playground-image-btn");
    if (generateBtn) generateBtn.addEventListener("click", () => this.handleGeneratePlaygroundImage());
    document.getElementById("playground-build-prompt-btn")?.addEventListener("click", () => this.openPlaygroundPromptBuilder());
    document.getElementById("playground-restore-idea-btn")?.addEventListener("click", () => this._restorePlaygroundIdea());
    // Typing in the box after a build makes the stashed idea stale.
    document.getElementById("playground-generate-prompt")?.addEventListener("input", () => {
      const restore = document.getElementById("playground-restore-idea-btn");
      if (restore) restore.style.display = "none";
    });
    const generateCountSelect = document.getElementById("playground-generate-count");
    if (generateCountSelect) {
      this._restorePlaygroundGenerateCount();
      generateCountSelect.addEventListener("change", (e) => {
        const value = e.target.value === "models" ? "models" : parseInt(e.target.value, 10) || 1;
        this.config.set("api.image.generateCount", value);
        this._syncPlaygroundGenerateMode();
      });
    }
    const generateRatioSelect = document.getElementById("playground-generate-ratio");
    if (generateRatioSelect) {
      this._restorePlaygroundGenerateRatio();
      generateRatioSelect.addEventListener("change", (e) => this.config.set("api.image.generateAspectRatio", e.target.value));
    }

    const saveBtn = document.getElementById("save-playground-image-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", () =>
        this.savePlaygroundImageToLibrary(this.playgroundImageUrl, this._currentPlaygroundLabel()));
    }

    const editBtn = document.getElementById("edit-playground-image-btn");
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditPlaygroundImage());

    // Prompt presets for each of the three text-driven tools.
    ["generate", "edit", "combine"].forEach(tool => this._initPlaygroundPresets(tool));

    this._updatePlaygroundUpscaleModelDropdown();
    const upscaleModelSelect = document.getElementById("playground-upscale-model");
    if (upscaleModelSelect) {
      upscaleModelSelect.addEventListener("change", (e) => this.config.set("api.image.upscaleModel", e.target.value));
    }
    const upscaleBtn = document.getElementById("upscale-playground-image-btn");
    if (upscaleBtn) upscaleBtn.addEventListener("click", () => this.handleUpscalePlaygroundImage());

    // Combine model dropdown — its own api.image.combineModel setting, not
    // synced with Edit's api.image.editModel, since a model that accepts
    // multiple reference images is a different category from one that just
    // edits a single image.
    this._updatePlaygroundCombineModelDropdown();
    const combineModelSelect = document.getElementById("playground-combine-model");
    if (combineModelSelect) {
      combineModelSelect.addEventListener("change", (e) => this.config.set("api.image.combineModel", e.target.value));
    }
    const combineBtn = document.getElementById("combine-images-btn");
    if (combineBtn) combineBtn.addEventListener("click", () => this.handleCombineImages());

    // Generate model dropdown — its own api.image.generateModel setting, not
    // synced with Edit's, since a plain text-to-image model is a different
    // category from an image-to-image one (same reasoning as Combine below).
    this._updatePlaygroundGenerateModelDropdown();

    // Edit model dropdown reads/writes the one api.image.editModel setting
    // (shared with the Settings text field too, see config.js).
    this._updatePlaygroundEditModelDropdown();
    const editModelSelect = document.getElementById("playground-edit-model");
    if (editModelSelect) {
      editModelSelect.addEventListener("change", (e) => this.config.set("api.image.editModel", e.target.value));
    }
  },

  // Switches which of the Generate / Crop / Edit / Combine panels is
  // visible. Crop is the shared modal tool (see image-cropper.js) embedded
  // inline here — opening it is what actually loads the current image into
  // its canvas, so selecting that tab triggers the same
  // openCropModal('playground') a button click used to.
  _setPlaygroundToolTab(tab) {
    this._pgActiveTab = tab;
    const tabs = { generate: "pg-tab-generate", crop: "pg-tab-crop", edit: "pg-tab-edit", enhance: "pg-tab-enhance", combine: "pg-tab-combine", library: "pg-tab-library" };
    const panels = { generate: "pg-panel-generate", crop: "pg-panel-crop", edit: "pg-panel-edit", enhance: "pg-panel-enhance", combine: "pg-panel-combine", library: "pg-panel-library" };

    Object.entries(tabs).forEach(([key, id]) => {
      const btn = document.getElementById(id);
      if (btn) btn.className = key === tab ? "btn-primary" : "btn-outline";
    });
    Object.entries(panels).forEach(([key, id]) => {
      const panel = document.getElementById(id);
      if (panel) panel.style.display = key === tab ? "block" : "none";
    });

    // Re-fetched on every open rather than once: the library is per-account, so
    // something saved on another device should show up simply by coming back to
    // this tab. Deliberately above the working-image check below — the library
    // is the one tool that has nothing to do with the current image.
    if (tab === "library" && typeof this.renderPlaygroundLibrary === "function") {
      this.renderPlaygroundLibrary();
    }

    if (!this.playgroundImageUrl) return;
    if (tab === "crop") this.openCropModal('playground');
  },

  // ── Model dropdowns ─────────────────────────────────────────────────────────
  // All three read the same model list but show only the models the user has
  // marked for that job in ⚙️ Settings → Image API (see
  // getImageModelCapabilities in config.js). Before that existed, each dropdown
  // listed every model and leaned on a name heuristic to flag the wrong ones —
  // which mattered because a plain text-to-image model handed a source image
  // doesn't error, it silently ignores the image and free-generates from the
  // prompt, so the mistake only shows up as a paid-for result with no
  // resemblance to the original.
  //
  // The shared helper falls back to listing everything (flagged) when nothing
  // is marked for a job, so no tool is ever left with an empty dropdown.

  _updatePlaygroundModelDropdown(selectId, capability, configKey, hintId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const result = populateImageModelSelect(select, capability, configKey, this.config);
    renderImageModelHint(document.getElementById(hintId), capability, result, this.config);
  },

  _updatePlaygroundEditModelDropdown() {
    this._updatePlaygroundModelDropdown(
      "playground-edit-model", "edit", "api.image.editModel", "playground-edit-model-hint",
    );
  },

  _updatePlaygroundUpscaleModelDropdown() {
    this._updatePlaygroundModelDropdown(
      "playground-upscale-model", "upscale", "api.image.upscaleModel", "playground-upscale-model-hint",
    );
  },

  // Enhance: a fixed "make this bigger and cleaner, change nothing else"
  // instruction at a larger requested size. Shares the working-image and
  // history mechanics with Edit — the difference is entirely in what is asked
  // for, so there is no separate result-handling path.
  async handleUpscalePlaygroundImage() {
    if (!this.playgroundImageUrl) {
      this.showNotification("Upload, paste or generate an image first", "warning");
      return;
    }

    const model = document.getElementById("playground-upscale-model")?.value
      || this.config.get("api.image.upscaleModel")
      || this.config.get("api.image.editModel");
    if (!model) {
      this.showNotification("Choose a model to enhance with first", "warning");
      return;
    }

    const scale = parseFloat(document.getElementById("playground-upscale-scale")?.value) || 2;
    const instruction = document.getElementById("playground-upscale-instruction")?.value?.trim() || "";

    const btn = document.getElementById("upscale-playground-image-btn");
    const statusEl = document.getElementById("playground-upscale-status");
    if (btn) btn.disabled = true;
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `⬆️ Enhancing at ${scale}× with ${model}… this may take a minute.`;
    }

    try {
      const resultUrl = await window.apiHandler.upscaleImage({
        imageBase64: this.playgroundImageUrl, model, scale, instruction,
      });
      const dataUrl = await this._urlToDataUrl(resultUrl);

      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
      this._addPlaygroundHistoryEntry(dataUrl, `Enhanced ${scale}× (${model})`, {
        tool: "enhance", model, prompt: instruction,
      });

      this.showNotification("Image enhanced!", "success");
    } catch (error) {
      console.error("Playground upscale error:", error);
      this.showNotification(`Enhance failed: ${error.message}`, "error", 6000);
    } finally {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
  },

  // ── Text-to-image generation ────────────────────────────────────────────────
  // The only Playground tool that doesn't need a working image first — it's
  // how one gets created from nothing but a prompt.
  _updatePlaygroundGenerateModelDropdown() {
    this._updatePlaygroundModelDropdown(
      "playground-generate-model", "generate", "api.image.generateModel", "playground-generate-model-hint",
    );
  },

  // Remembered per account like the model choice, so asking for 4 once sticks.
  _restorePlaygroundGenerateCount() {
    const select = document.getElementById("playground-generate-count");
    if (!select) return;
    const saved = String(this.config.get("api.image.generateCount") || 1);
    if ([...select.options].some(o => o.value === saved)) select.value = saved;
    this._syncPlaygroundGenerateMode();
  },

  // "1 per model" swaps the model dropdown for a checklist: the same prompt
  // drawn once by each ticked model, to see which suits it.
  _syncPlaygroundGenerateMode() {
    const perModel = document.getElementById("playground-generate-count")?.value === "models";
    const single = document.getElementById("playground-generate-single-model");
    const compare = document.getElementById("playground-generate-compare");
    if (single) single.style.display = perModel ? "none" : "";
    if (compare) compare.style.display = perModel ? "" : "none";
    if (perModel) this._renderPlaygroundCompareList();
  },

  // Shares its picks with Character Gen's ⚔️ Compare Models, so there is one
  // "models I compare" list. Same defaults too: last picks, else the local GPU
  // models (free to run), else the first few.
  _renderPlaygroundCompareList() {
    const list = document.getElementById("playground-generate-compare-list");
    if (!list) return;
    const MAX_MODELS = 4;
    const candidates = getImageModelsWithCapability("generate", this.config);
    const saved = (this.config.get("api.image.compareModels") || []).filter(m => candidates.includes(m));
    const local = candidates.filter(m => m.startsWith("local/"));
    const preselected = new Set(saved.length ? saved : local.length ? local.slice(0, MAX_MODELS) : candidates.slice(0, 2));

    list.innerHTML = "";
    if (!candidates.length) {
      list.innerHTML = `<p style="margin:0; font-size:0.75rem; color:var(--warning);">No models are marked 🪄 Generate in ⚙️ Settings → Image API.</p>`;
      return;
    }
    candidates.forEach(model => {
      const row = document.createElement("label");
      row.style.cssText = "display:flex; align-items:center; gap:0.5rem; cursor:pointer; color:var(--text-primary); font-size:0.85rem;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = model;
      cb.checked = preselected.has(model);
      cb.addEventListener("change", () => {
        const chosen = [...list.querySelectorAll("input:checked")].map(c => c.value);
        if (chosen.length > MAX_MODELS) {
          cb.checked = false;
          this.showNotification(`Pick at most ${MAX_MODELS} models.`, "warning");
          return;
        }
        this.config.set("api.image.compareModels", chosen);
      });
      const name = document.createElement("span");
      name.style.cssText = "font-family:monospace; overflow-wrap:anywhere;";
      name.textContent = model;
      row.append(cb, name);
      list.appendChild(row);
    });
  },

  // Until this had its own setting, Playground used Character Gen's Aspect
  // Ratio, so an unsaved choice starts from that rather than changing shape
  // under someone who never touched it.
  _restorePlaygroundGenerateRatio() {
    const select = document.getElementById("playground-generate-ratio");
    if (!select) return;
    const saved = this.config.get("api.image.generateAspectRatio") || this.config.get("api.image.aspectRatio") || "1:1";
    if ([...select.options].some(o => o.value === saved)) select.value = saved;
  },

  // ✨ Build: the box's text is the idea for the Prompt Builder, and the built
  // prompt replaces it. Writes for the dropdown's model, or the first ticked
  // model in "1 per model" mode. If the box still holds the last built prompt,
  // the idea it was built from goes back into the builder instead, so a second
  // build steers from what you wrote rather than from the long result.
  openPlaygroundPromptBuilder() {
    if (!window.promptBuilder) return;
    const promptEl = document.getElementById("playground-generate-prompt");
    const perModel = document.getElementById("playground-generate-count")?.value === "models";
    const model = (perModel && document.querySelector("#playground-generate-compare-list input:checked")?.value)
      || document.getElementById("playground-generate-model")?.value
      || this.config.get("api.image.generateModel") || "";
    const text = promptEl?.value?.trim() || "";
    const idea = this._pgBuiltPrompt && text === this._pgBuiltPrompt.trim() ? this._pgIdeaBeforeBuild || text : text;

    window.promptBuilder.open({
      host: "playground",
      subject: { kind: "idea", idea },
      model,
      shape: document.getElementById("playground-generate-ratio")?.value || "1:1",
      onUse: ({ prompt, takes, subject, generate }) => {
        if (!promptEl) return;
        // The idea as last edited in the builder, which is what the prompt was built from.
        this._pgIdeaBeforeBuild = subject?.idea ?? idea;
        this._pgBuiltPrompt = prompt;
        promptEl.value = prompt;
        promptEl.rows = Math.min(14, Math.max(5, Math.ceil(prompt.length / 70)));
        const restore = document.getElementById("playground-restore-idea-btn");
        if (restore) restore.style.display = this._pgIdeaBeforeBuild ? "inline-flex" : "none";
        if (generate && takes?.length) this.handleGeneratePlaygroundImage({ takes, model });
        else if (generate) this.handleGeneratePlaygroundImage();
        else promptEl.focus();
      },
    });
  },

  _restorePlaygroundIdea() {
    const promptEl = document.getElementById("playground-generate-prompt");
    if (!promptEl || this._pgIdeaBeforeBuild === undefined) return;
    promptEl.value = this._pgIdeaBeforeBuild;
    promptEl.rows = 3;
    this._pgBuiltPrompt = null;
    const restore = document.getElementById("playground-restore-idea-btn");
    if (restore) restore.style.display = "none";
  },

  // Generates a fresh image from a prompt alone and makes it the working
  // image — same as an upload/paste, including resetting history (a newly
  // generated image is unrelated to whatever was there before). Stays on the
  // Generate tab afterwards so another go is one tap away.
  //
  // Asking for more than one runs that many separate calls in parallel rather
  // than one call with `n`: not every nano-gpt model honours `n`, and separate
  // calls each get their own seed and their own resumable job, so a phone
  // locking mid-batch loses none of them. The first to land becomes the
  // working image; the rest fill a grid to pick from.
  //
  // `takes` ([{ label, prompt }], from the Prompt Builder's 🖼️ Generate all)
  // draws one image per take with `model` instead, each from its own prompt,
  // badged with the take's label.
  async handleGeneratePlaygroundImage({ takes = null, model: takesModel = "" } = {}) {
    const promptEl = document.getElementById("playground-generate-prompt");
    const prompt = takes ? takes[0].prompt : promptEl?.value?.trim();
    if (!prompt) {
      this.showNotification("Describe the image you want to create first", "warning");
      promptEl?.focus();
      return;
    }
    const promptAt = (index) => (takes ? takes[index].prompt : prompt);
    this._pgGenerateLabels = takes ? takes.map(t => t.label) : null;

    // One model per slot: the dropdown's model N times, or each ticked model once.
    const perModel = !takes && document.getElementById("playground-generate-count")?.value === "models";
    let models;
    if (takes) {
      const model = takesModel || document.getElementById("playground-generate-model")?.value || this.config.get("api.image.generateModel");
      if (!model) {
        this.showNotification("Choose a model first (⚙️ Settings → Image API → Fetch Models)", "warning");
        return;
      }
      models = takes.map(() => model);
    } else if (perModel) {
      models = [...document.querySelectorAll("#playground-generate-compare-list input:checked")].map(cb => cb.value);
      if (!models.length) {
        this.showNotification("Tick at least one model to generate with", "warning");
        return;
      }
    } else {
      const model = document.getElementById("playground-generate-model")?.value
        || this.config.get("api.image.generateModel");
      if (!model) {
        this.showNotification("Choose a model first (⚙️ Settings → Image API → Fetch Models)", "warning");
        return;
      }
      const n = parseInt(document.getElementById("playground-generate-count")?.value, 10) || 1;
      models = Array(n).fill(model);
    }
    const count = models.length;
    // Grid whenever there's a choice to make, including a single ticked model
    // in per-model mode, so its tile still says which model drew it.
    const showGrid = count > 1 || perModel || !!takes;
    this._pgGenerateByModel = perModel;
    this._pgGenerateModels = models;
    const aspectRatio = document.getElementById("playground-generate-ratio")?.value || "1:1";

    const btn = document.getElementById("generate-playground-image-btn");
    const statusEl = document.getElementById("playground-generate-status");
    if (btn) btn.disabled = true;
    const setStatus = (done) => {
      if (!statusEl) return;
      statusEl.style.display = "block";
      statusEl.textContent = takes
        ? `🖼️ Drawing ${count} takes with ${models[0]}… ${done}/${count} done, this may take a minute.`
        : perModel
        ? `🪄 Generating with ${count} model${count > 1 ? "s" : ""}… ${done}/${count} done, this may take a minute.`
        : count > 1
          ? `🪄 Generating ${count} with ${models[0]}… ${done}/${count} done, this may take a minute.`
          : `🪄 Generating with ${models[0]}… this may take a minute.`;
    };
    setStatus(0);

    // One slot per requested image; null while pending, { url } or { error } once settled.
    this._pgGenerateResults = showGrid ? Array.from({ length: count }, () => null) : [];
    this._renderPlaygroundGenerateResults();

    let first = true;
    let done = 0;
    const runOne = async (index) => {
      const model = models[index];
      const prompt = promptAt(index);
      try {
        const resultUrl = await window.apiHandler.generateImageFromPrompt({ prompt, model, aspectRatio });
        const dataUrl = await this._urlToDataUrl(resultUrl);
        if (showGrid) this._pgGenerateResults[index] = { url: dataUrl, model, prompt };

        if (first) {
          first = false;
          this.playgroundImageUrl = dataUrl;
          this.updatePlaygroundImagePreview(dataUrl);
          if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
          this.playgroundHistory = [];
          this._addPlaygroundHistoryEntry(dataUrl, `Generated (${model})`, {
            tool: "generate", model, prompt,
          });
        }
      } catch (error) {
        console.error("Playground generate error:", error);
        if (showGrid) this._pgGenerateResults[index] = { error: error.message, model };
        throw error;
      } finally {
        done++;
        setStatus(done);
        this._renderPlaygroundGenerateResults();
      }
    };

    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: count }, (_, i) => runOne(i)),
      );
      const failures = outcomes.filter(o => o.status === "rejected");
      if (failures.length === count) {
        this.showNotification(`Failed: ${failures[0].reason?.message || "unknown error"}`, "error", 6000);
      } else if (failures.length) {
        this.showNotification(
          `${count - failures.length} of ${count} generated — ${failures.length} failed: ${failures[0].reason?.message || "unknown error"}`,
          "warning", 6000,
        );
      } else {
        this.showNotification(showGrid ? `${count} image${count > 1 ? "s" : ""} generated — tap one to pick it` : "Image generated!", "success");
      }
    } finally {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
  },

  // The pick-one grid under the Generate button. Hidden for single-image runs —
  // the preview above already shows the only result.
  _renderPlaygroundGenerateResults() {
    const grid = document.getElementById("playground-generate-results");
    if (!grid) return;

    const results = this._pgGenerateResults || [];
    if (!results.length) {
      grid.style.display = "none";
      grid.innerHTML = "";
      return;
    }

    grid.style.display = "grid";
    grid.innerHTML = "";

    // In per-model mode the badge names the model, which is the whole point.
    const byModel = !!this._pgGenerateByModel;
    const modelOf = (index) => (byModel ? this._pgGenerateResults[index]?.model || this._pgGenerateModels?.[index] : null);
    const badgeText = (index) => {
      const take = this._pgGenerateLabels?.[index];
      if (take) return take;
      const model = modelOf(index);
      return model ? model.replace(/^local\//, "💻 ") : String(index + 1);
    };

    results.forEach((result, index) => {
      const tile = document.createElement("div");
      const isActive = !!result?.url && result.url === this.playgroundImageUrl;
      tile.style.cssText = `
        position: relative; aspect-ratio: 1 / 1; border-radius: 0.5rem; overflow: hidden;
        background: var(--bg-secondary, rgba(0,0,0,0.15));
        border: 3px solid ${isActive ? "var(--accent)" : "var(--border)"};
        display: flex; align-items: center; justify-content: center; text-align: center;
        font-size: 0.75rem; color: var(--text-soft); padding: ${result?.url ? "0" : "0.5rem"};
      `;

      const pendingLabel = byModel || this._pgGenerateLabels ? `\n${badgeText(index)}` : "";
      if (!result) {
        tile.style.whiteSpace = "pre-line";
        tile.textContent = `⏳ Generating…${pendingLabel}`;
      } else if (result.error) {
        tile.style.whiteSpace = "pre-line";
        tile.title = result.error;
        tile.textContent = `❌ Failed${pendingLabel}`;
      } else {
        tile.style.cursor = "pointer";
        tile.title = isActive ? "This is the working image" : "Tap to make this the working image";
        tile.innerHTML = `
          <img src="${result.url}" alt="Option ${index + 1}" style="width: 100%; height: 100%; object-fit: contain; display: block;">
          <span style="position:absolute; top:0; left:0; background:rgba(0,0,0,0.55); color:#fff; font-size:0.7rem; padding:0.15rem 0.35rem; border-bottom-right-radius:0.4rem; max-width:calc(100% - 2.5rem); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${isActive ? "✓ " : ""}${escapeHtml(badgeText(index))}</span>
          <button type="button" data-save title="Save this one to your image library"
            style="position:absolute; bottom:0; right:0; border:none; background:rgba(0,0,0,0.55); color:#fff; font-size:0.85rem; line-height:1; padding:0.35rem 0.45rem; cursor:pointer;"
          >💾</button>
        `;
        tile.querySelector("[data-save]").addEventListener("click", (e) => {
          e.stopPropagation();
          this.savePlaygroundImageToLibrary(result.url, `Generated (${result.model})`, result.prompt);
        });
        tile.addEventListener("click", () => this._pickPlaygroundGenerateResult(index));
      }
      grid.appendChild(tile);
    });
  },

  // Adds the pick to the history strip rather than resetting it, so swapping
  // between options — or back to one already edited — never throws work away.
  _pickPlaygroundGenerateResult(index) {
    const result = this._pgGenerateResults?.[index];
    if (!result?.url || result.url === this.playgroundImageUrl) return;

    this.playgroundImageUrl = result.url;
    this.updatePlaygroundImagePreview(result.url);
    if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
    this._addPlaygroundHistoryEntry(result.url, `Generated (${result.model})`, {
      tool: "generate", model: result.model, prompt: result.prompt,
    });
    // _addPlaygroundHistoryEntry skips a duplicate of the last entry and so
    // doesn't always re-render; the highlight must move regardless.
    this._renderPlaygroundHistory();
  },

  async handlePlaygroundImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    await this.processPlaygroundImageFile(file);
    if (event.target) event.target.value = "";
  },

  async handlePlaygroundImagePaste(event) {
    setTimeout(() => this._resetPasteZones(), 0);
    const file = this._extractPastedImageFile(event);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    await this.processPlaygroundImageFile(file);
  },

  async processPlaygroundImageFile(file) {
    try {
      this.imageGenerator.validateImageFile(file);
      // prepareReferenceImageForVision is really just a generic "resize and
      // return a JPEG data URL" helper despite its name. Larger than its
      // 1024px default, since this is the image being edited.
      const dataUrl = await this.prepareReferenceImageForVision(file, PLAYGROUND_IMAGE_ENCODING);

      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();

      // A fresh upload/paste starts a new working image — any earlier
      // history belongs to a different image and would be confusing to keep.
      this.playgroundHistory = [];
      this._addPlaygroundHistoryEntry(dataUrl, "Original");

      const toolsSection = document.getElementById("playground-tools-section");
      if (toolsSection) toolsSection.style.display = "block";
      this._setPlaygroundToolTab("edit");
    } catch (error) {
      console.error("Playground image handling failed:", error);
      this.showNotification(`Image upload failed: ${error.message}`, "warning");
    }
  },

  updatePlaygroundImagePreview(dataUrl) {
    const preview = document.getElementById("playground-image-preview");
    if (!preview) return;
    preview.style.display = "block";
    preview.innerHTML = `<img src="${dataUrl}" alt="Playground image" style="width: 100%; display: block;" />`;

    const saveRow = document.getElementById("playground-save-row");
    if (saveRow) saveRow.style.display = dataUrl ? "block" : "none";
  },

  // How the working image came to be, as recorded in the history strip — saved
  // alongside the image so the library can say what made it.
  _currentPlaygroundLabel() {
    const entry = (this.playgroundHistory || []).find(e => e.url === this.playgroundImageUrl);
    return entry?.label || "";
  },

  // Applies the result immediately rather than opening a compare-and-choose
  // modal like the card/reference edit flows do: the history strip
  // (_addPlaygroundHistoryEntry) already keeps every prior version
  // reachable, so the modal's only job — giving a way back to "current" — is
  // redundant here, and it was in the way of a quick "try it, see it, try
  // again" workflow.
  async handleEditPlaygroundImage() {
    if (!this.playgroundImageUrl) {
      this.showNotification("Upload or paste an image first", "warning");
      return;
    }

    const instructionEl = document.getElementById("playground-edit-instruction");
    const instruction = instructionEl?.value?.trim();
    if (!instruction) {
      this.showNotification("Describe what you want to change first", "warning");
      instructionEl?.focus();
      return;
    }

    const imageApiBase = this.config.get("api.image.baseUrl");
    const imageApiKey = this.config.get("api.image.apiKey");
    if (!imageApiBase || !imageApiKey) {
      this.showNotification("Please configure image API settings first", "warning");
      return;
    }
    const editModel = document.getElementById("playground-edit-model")?.value
      || this.config.get("api.image.editModel")
      || "flux-2-pro-image-to-image";

    const actionBtn = document.getElementById("edit-playground-image-btn");
    const statusEl = document.getElementById("playground-edit-status");
    if (actionBtn) actionBtn.disabled = true;
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `✨ Working with ${editModel}… this may take a minute.`;
    }

    try {
      const imageBase64 = this.playgroundImageUrl;

      const resultUrl = await window.apiHandler.editImage({ imageBase64, instruction, model: editModel });

      const dataUrl = await this._urlToDataUrl(resultUrl);

      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
      this._addPlaygroundHistoryEntry(dataUrl, `Edited (${editModel})`, {
        tool: "edit",
        model: editModel,
        prompt: instruction,
      });

      this.showNotification("Image updated!", "success");
    } catch (error) {
      console.error("Playground edit error:", error);
      this.showNotification(`Failed: ${error.message}`, "error", 6000);
    } finally {
      if (actionBtn) actionBtn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
  },

  // ── History strip ──────────────────────────────────────────────────────────
  // Every version of the working image (original, plus after each crop/edit)
  // as a non-destructive, click-to-revisit thumbnail strip — this is what
  // makes it safe to apply edits immediately above instead of asking the
  // user to confirm via a compare modal first.

  // Each entry holds a whole data URL — a cropped PNG runs 1-2 MB — so an
  // uncapped strip is tens of megabytes of live memory after a dozen
  // operations, which on an iPhone is enough for Safari to discard the tab and
  // lose the working image entirely. Saving to the library (💾) is what makes
  // a version durable; this strip is only a short undo trail.
  _PLAYGROUND_HISTORY_MAX: 15,

  // `meta` records what actually produced this version — { tool, model, prompt }.
  // Without it the strip
  // was a row of pictures with no way to tell what made any of them, and no way
  // to run the same instruction again against a different model.
  _addPlaygroundHistoryEntry(url, label, meta = null) {
    if (!this.playgroundHistory) this.playgroundHistory = [];
    const last = this.playgroundHistory[this.playgroundHistory.length - 1];
    if (last && last.url === url) return; // avoid consecutive dupes (e.g. re-selecting the active entry)
    this.playgroundHistory.push({ url, label, meta });

    // Drops the *second* entry rather than the first: index 0 is the original
    // upload/generation, which is the one version people actually want to get
    // back to, so it is the last thing that should be evicted.
    while (this.playgroundHistory.length > this._PLAYGROUND_HISTORY_MAX) {
      this.playgroundHistory.splice(1, 1);
    }
    this._renderPlaygroundHistory();
  },

  _renderPlaygroundHistory() {
    // The Generate pick grid highlights the working image too, and every
    // change of working image ends up here.
    this._renderPlaygroundGenerateResults();

    const strip = document.getElementById("playground-history-strip");
    if (!strip) return;

    if (!this.playgroundHistory || this.playgroundHistory.length < 2) {
      strip.style.display = "none";
      strip.innerHTML = "";
      return;
    }

    strip.style.display = "flex";
    strip.innerHTML = "";

    this.playgroundHistory.forEach((entry, index) => {
      const isActive = entry.url === this.playgroundImageUrl;

      const thumb = document.createElement("div");
      thumb.title = entry.meta?.prompt
        ? `${entry.label}\n"${entry.meta.prompt}"`
        : entry.label;
      thumb.style.cssText = `
        flex: 0 0 auto; position: relative; width: 64px; height: 64px; cursor: pointer;
        border-radius: 0.5rem; overflow: hidden;
        border: 2px solid ${isActive ? "var(--accent)" : "var(--border)"};
      `;
      // ↻ only appears on versions that record how they were made — the
      // original upload has nothing to reuse.
      const reuseBtn = entry.meta?.tool
        ? `<button type="button" data-reuse-index="${index}" title="Put this prompt and model back in the panel, ready to run again"
             style="position:absolute; bottom:0; left:0; border:none; background:rgba(0,0,0,0.55); color:#fff; font-size:0.7rem; line-height:1; padding:0.2rem 0.3rem; cursor:pointer;"
           >↻</button>`
        : "";
      thumb.innerHTML = `
        <img src="${entry.url}" alt="${escapeHtml(entry.label || "")}" style="width: 100%; height: 100%; object-fit: cover; display: block;">
        ${reuseBtn}
        <button type="button" data-save-index="${index}" title="Save this version to your image library"
          style="position:absolute; bottom:0; right:0; border:none; background:rgba(0,0,0,0.55); color:#fff; font-size:0.7rem; line-height:1; padding:0.2rem 0.3rem; cursor:pointer;"
        >💾</button>
      `;
      thumb.addEventListener("click", (e) => {
        if (e.target.closest("[data-save-index]") || e.target.closest("[data-reuse-index]")) return;
        this._selectPlaygroundHistoryEntry(index);
      });
      const saveBtn = thumb.querySelector("[data-save-index]");
      if (saveBtn) {
        saveBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._savePlaygroundHistoryEntry(index);
        });
      }
      const reuse = thumb.querySelector("[data-reuse-index]");
      if (reuse) {
        reuse.addEventListener("click", (e) => {
          e.stopPropagation();
          this._reusePlaygroundHistoryEntry(index);
        });
      }
      strip.appendChild(thumb);
    });
  },

  _selectPlaygroundHistoryEntry(index) {
    const entry = this.playgroundHistory?.[index];
    if (!entry) return;
    this.playgroundImageUrl = entry.url;
    this.updatePlaygroundImagePreview(entry.url);
    if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
    this._renderPlaygroundHistory();

    // If Crop is the open tab, reload its canvas with the now-current image
    // rather than leaving it showing a stale version.
    if (this._pgActiveTab === "crop") this.openCropModal('playground');
  },

  // Saves to the account's image library rather than downloading to this
  // device: an image made on a phone used to be stranded on that phone, and
  // the library is where every other action on it now lives (view, delete,
  // download, start a character from it — see playground-library.js).
  _savePlaygroundHistoryEntry(index) {
    const entry = this.playgroundHistory?.[index];
    if (!entry) return;
    // The entry knows the prompt that produced it; the panel may since have
    // been retyped, so prefer the recorded one.
    this.savePlaygroundImageToLibrary(entry.url, entry.label || "", entry.meta?.prompt);
  },

  // Refills the panel that produced a version with the same prompt and model
  // and switches to it — deliberately WITHOUT running it. Every one of these
  // calls costs credits, so the last step stays a decision the user makes;
  // this only removes the retyping. Swapping the model before pressing the
  // button is the whole point ("same instruction, better model").
  _reusePlaygroundHistoryEntry(index) {
    const entry = this.playgroundHistory?.[index];
    const meta = entry?.meta;
    if (!meta?.tool) return;

    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el && value !== undefined && value !== null && value !== "") el.value = value;
    };

    if (meta.tool === "generate") {
      setValue("playground-generate-prompt", meta.prompt);
      setValue("playground-generate-model", meta.model);
      this._setPlaygroundToolTab("generate");
    } else if (meta.tool === "edit") {
      setValue("playground-edit-instruction", meta.prompt);
      setValue("playground-edit-model", meta.model);
      this._setPlaygroundToolTab("edit");
    } else if (meta.tool === "combine") {
      setValue("playground-combine-instruction", meta.prompt);
      setValue("playground-combine-model", meta.model);
      this._setPlaygroundToolTab("combine");
    } else if (meta.tool === "enhance") {
      setValue("playground-upscale-instruction", meta.prompt);
      setValue("playground-upscale-model", meta.model);
      this._setPlaygroundToolTab("enhance");
    } else {
      return;
    }

    this.showNotification("Settings restored — adjust the model or wording, then run it again.", "info", 5000);
  },

  // ── Prompt presets ──────────────────────────────────────────────────────────
  // Common instructions ("remove the background", "convert to photoreal") are
  // retyped constantly and are fiddly to type on a phone, which is this app's
  // primary client. Built-ins plus whatever the user saves, per tool — an Edit
  // instruction is no use in the Generate box, so the lists are kept separate.

  _playgroundPresetFieldId(tool) {
    return tool === "generate" ? "playground-generate-prompt"
      : tool === "edit" ? "playground-edit-instruction"
      : "playground-combine-instruction";
  },

  _initPlaygroundPresets(tool) {
    const select = document.getElementById(`playground-${tool}-preset`);
    const saveBtn = document.getElementById(`playground-${tool}-preset-save`);
    const deleteBtn = document.getElementById(`playground-${tool}-preset-delete`);
    if (!select) return;

    this._renderPlaygroundPresets(tool);

    select.addEventListener("change", () => {
      const chosen = this._findPlaygroundPreset(tool, select.value);
      if (!chosen) return;
      const field = document.getElementById(this._playgroundPresetFieldId(tool));
      if (field) {
        field.value = chosen.text;
        field.focus();
      }
      // Deleting is only meaningful for a saved preset, never a built-in.
      if (deleteBtn) deleteBtn.style.display = chosen.builtIn ? "none" : "";
    });

    if (saveBtn) saveBtn.addEventListener("click", () => this._savePlaygroundPreset(tool));
    if (deleteBtn) deleteBtn.addEventListener("click", () => this._deletePlaygroundPreset(tool));
  },

  _userPlaygroundPresets(tool) {
    const all = this.config.get("api.image.promptPresets") || [];
    return all.filter(preset => preset && preset.tool === tool);
  },

  _findPlaygroundPreset(tool, id) {
    if (!id) return null;
    const builtIn = (PLAYGROUND_BUILTIN_PRESETS[tool] || [])
      .map((preset, i) => ({ ...preset, id: `builtin:${i}`, builtIn: true }));
    return [...builtIn, ...this._userPlaygroundPresets(tool)].find(preset => preset.id === id) || null;
  },

  _renderPlaygroundPresets(tool, selectedId = "") {
    const select = document.getElementById(`playground-${tool}-preset`);
    if (!select) return;

    const builtIn = PLAYGROUND_BUILTIN_PRESETS[tool] || [];
    const mine = this._userPlaygroundPresets(tool);

    const option = (value, label, selected) =>
      `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;

    let html = option("", "— Prompt presets —", !selectedId);
    if (builtIn.length > 0) {
      html += `<optgroup label="Built in">`
        + builtIn.map((preset, i) => option(`builtin:${i}`, preset.name, selectedId === `builtin:${i}`)).join("")
        + `</optgroup>`;
    }
    if (mine.length > 0) {
      html += `<optgroup label="Yours">`
        + mine.map(preset => option(preset.id, preset.name, selectedId === preset.id)).join("")
        + `</optgroup>`;
    }
    select.innerHTML = html;

    const deleteBtn = document.getElementById(`playground-${tool}-preset-delete`);
    if (deleteBtn) {
      const chosen = this._findPlaygroundPreset(tool, selectedId);
      deleteBtn.style.display = chosen && !chosen.builtIn ? "" : "none";
    }
  },

  _savePlaygroundPreset(tool) {
    const field = document.getElementById(this._playgroundPresetFieldId(tool));
    const text = field?.value?.trim();
    if (!text) {
      this.showNotification("Type the prompt you want to save first", "warning");
      field?.focus();
      return;
    }

    const name = (prompt("Name this preset:", text.slice(0, 40)) || "").trim();
    if (!name) return;

    const presets = [...(this.config.get("api.image.promptPresets") || [])];
    const existing = presets.find(preset => preset.tool === tool && preset.name === name);
    if (existing) {
      if (!confirm(`Replace the existing preset "${name}"?`)) return;
      existing.text = text;
      this.config.set("api.image.promptPresets", presets);
      this._renderPlaygroundPresets(tool, existing.id);
    } else {
      const preset = { id: `user:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, tool, name, text };
      presets.push(preset);
      this.config.set("api.image.promptPresets", presets);
      this._renderPlaygroundPresets(tool, preset.id);
    }
    this.showNotification(`Saved preset "${name}"`, "success");
  },

  _deletePlaygroundPreset(tool) {
    const select = document.getElementById(`playground-${tool}-preset`);
    const chosen = this._findPlaygroundPreset(tool, select?.value);
    if (!chosen || chosen.builtIn) return;
    if (!confirm(`Delete the preset "${chosen.name}"?`)) return;

    const presets = (this.config.get("api.image.promptPresets") || [])
      .filter(preset => preset.id !== chosen.id);
    this.config.set("api.image.promptPresets", presets);
    this._renderPlaygroundPresets(tool);
    this.showNotification("Preset deleted", "success");
  },

  // ── Two-image combining ──────────────────────────────────────────────────────
  // Unlike Edit (a single-image editImage() call), this needs a model that
  // accepts multiple reference images in one call
  // (apiHandler.combineImages, its own proxy route), which is a genuinely
  // different, less-common capability. Nothing in a model's name signals it
  // (qwen-image-3-pro, reve/2.1/remix and xai/…/edit all do it, with nothing in
  // common), so unlike Edit there's no heuristic to seed the marks from — the
  // 🔀 box in Settings starts unticked for everything and the list falls back
  // to showing all models until the user marks one.
  _updatePlaygroundCombineModelDropdown() {
    this._updatePlaygroundModelDropdown(
      "playground-combine-model", "combine", "api.image.combineModel", "playground-combine-model-hint",
    );
  },

  async handleCombineImage2Upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    await this._processCombineImage2File(file);
    if (event.target) event.target.value = "";
  },

  async handleCombineImage2Paste(event) {
    setTimeout(() => this._resetPasteZones(), 0);
    const file = this._extractPastedImageFile(event);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    await this._processCombineImage2File(file);
  },

  async _processCombineImage2File(file) {
    try {
      this.imageGenerator.validateImageFile(file);
      const dataUrl = await this.prepareReferenceImageForVision(file, PLAYGROUND_IMAGE_ENCODING);
      this.combineImage2Url = dataUrl;

      const preview = document.getElementById("combine-image2-preview");
      if (preview) {
        preview.style.display = "block";
        preview.innerHTML = `<img src="${dataUrl}" alt="Image 2" style="width: 100%; display: block;" />`;
      }
    } catch (error) {
      console.error("Combine Image 2 handling failed:", error);
      this.showNotification(`Image upload failed: ${error.message}`, "warning");
    }
  },

  async handleCombineImages() {
    if (!this.playgroundImageUrl) {
      this.showNotification("Upload or paste Image 1 (the main working image) first", "warning");
      return;
    }
    if (!this.combineImage2Url) {
      this.showNotification("Add Image 2 first", "warning");
      return;
    }

    const instructionEl = document.getElementById("playground-combine-instruction");
    const instruction = instructionEl?.value?.trim();
    if (!instruction) {
      this.showNotification("Describe how to combine the two images first", "warning");
      instructionEl?.focus();
      return;
    }

    const combineModel = document.getElementById("playground-combine-model")?.value
      || this.config.get("api.image.combineModel");
    if (!combineModel) {
      this.showNotification("Choose a model that supports combining multiple images first", "warning");
      return;
    }

    const btn = document.getElementById("combine-images-btn");
    const statusEl = document.getElementById("playground-combine-status");
    if (btn) btn.disabled = true;
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `🔀 Combining with ${combineModel}… this may take a minute.`;
    }

    try {
      const resultUrl = await this.apiHandler.combineImages({
        images: [this.playgroundImageUrl, this.combineImage2Url],
        instruction,
        model: combineModel,
      });

      const dataUrl = await this._urlToDataUrl(resultUrl);
      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
      this._addPlaygroundHistoryEntry(dataUrl, `Combined (${combineModel})`, {
        tool: "combine", model: combineModel, prompt: instruction,
      });

      this.showNotification("Images combined!", "success");
    } catch (error) {
      console.error("Combine images error:", error);
      this.showNotification(`Combine failed: ${error.message}`, "error", 6000);
    } finally {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
  },

});
