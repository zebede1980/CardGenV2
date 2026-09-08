// Image Playground — a standalone image-editing workspace with no card or
// character concept involved. Reuses the same crop/edit tooling already
// generalized for the reference-image section (see image-cropper.js,
// image-handler.js's handleEditReferenceImage) via a third 'playground'
// target, working on this.playgroundImageUrl instead of a card's portrait or
// the pre-generation reference image.
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

  // Generates a fresh image from a prompt alone and makes it the working
  // image — same as an upload/paste, including resetting history (a newly
  // generated image is unrelated to whatever was there before) and handing
  // off to the Edit tab afterward, matching processPlaygroundImageFile.
  async handleGeneratePlaygroundImage() {
    const promptEl = document.getElementById("playground-generate-prompt");
    const prompt = promptEl?.value?.trim();
    if (!prompt) {
      this.showNotification("Describe the image you want to create first", "warning");
      promptEl?.focus();
      return;
    }

    const model = document.getElementById("playground-generate-model")?.value
      || this.config.get("api.image.generateModel");
    if (!model) {
      this.showNotification("Choose a model first (⚙️ Settings → Image API → Fetch Models)", "warning");
      return;
    }

    const btn = document.getElementById("generate-playground-image-btn");
    const statusEl = document.getElementById("playground-generate-status");
    if (btn) btn.disabled = true;
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `🪄 Generating with ${model}… this may take a minute.`;
    }

    try {
      const resultUrl = await window.apiHandler.generateImageFromPrompt({ prompt, model });
      const dataUrl = await this._urlToDataUrl(resultUrl);

      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();

      this.playgroundHistory = [];
      this._addPlaygroundHistoryEntry(dataUrl, `Generated (${model})`, {
        tool: "generate", model, prompt,
      });

      this.showNotification("Image generated!", "success");
      this._setPlaygroundToolTab("edit");
    } catch (error) {
      console.error("Playground generate error:", error);
      this.showNotification(`Failed: ${error.message}`, "error", 6000);
    } finally {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
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
      // prepareReferenceImageForVision is really just a generic "resize to
      // max 1024px, return a JPEG data URL" helper despite its name — no
      // vision-specific behavior, safe to reuse here.
      const dataUrl = await this.prepareReferenceImageForVision(file);

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

    const useLocalForge = document.getElementById("playground-edit-use-forge")?.checked;
    const denoisingStrength = parseFloat(document.getElementById("playground-edit-denoising")?.value) || 0.55;

    let editModel;
    if (useLocalForge) {
      editModel = `local-forge (denoise ${denoisingStrength})`;
    } else {
      const imageApiBase = this.config.get("api.image.baseUrl");
      const imageApiKey = this.config.get("api.image.apiKey");
      if (!imageApiBase || !imageApiKey) {
        this.showNotification("Please configure image API settings first", "warning");
        return;
      }
      editModel = document.getElementById("playground-edit-model")?.value
        || this.config.get("api.image.editModel")
        || "flux-2-pro-image-to-image";
    }

    const actionBtn = document.getElementById("edit-playground-image-btn");
    const statusEl = document.getElementById("playground-edit-status");
    if (actionBtn) actionBtn.disabled = true;
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `✨ Working with ${editModel}… this may take a minute.`;
    }

    try {
      const imageBase64 = this.playgroundImageUrl;

      const resultUrl = useLocalForge
        ? await window.apiHandler.editForgeImage({ imageBase64, instruction, denoisingStrength })
        : await window.apiHandler.editImage({ imageBase64, instruction, model: editModel });

      const dataUrl = await this._urlToDataUrl(resultUrl);

      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
      this._addPlaygroundHistoryEntry(dataUrl, `Edited (${editModel})`, {
        tool: "edit",
        model: useLocalForge ? "" : editModel,
        prompt: instruction,
        useLocalForge: !!useLocalForge,
        denoisingStrength,
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

  // `meta` records what actually produced this version — { tool, model, prompt }
  // and, for a Local Forge edit, its denoising strength. Without it the strip
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
      const forgeToggle = document.getElementById("playground-edit-use-forge");
      if (forgeToggle) forgeToggle.checked = !!meta.useLocalForge;
      setValue("playground-edit-denoising", meta.denoisingStrength);
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
      const dataUrl = await this.prepareReferenceImageForVision(file);
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
