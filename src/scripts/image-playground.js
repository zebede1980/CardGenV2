// Image Playground — a standalone image-editing workspace with no card or
// character concept involved. Reuses the same crop/edit tooling already
// generalized for the reference-image section (see image-cropper.js,
// image-handler.js's handleEditReferenceImage) via a third 'playground'
// target, working on this.playgroundImageUrl instead of a card's portrait or
// the pre-generation reference image.
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
    const otherTabs = ["tab-cardgen", "tab-storywriter", "tab-roleplaychat", "tab-adventure"]
      .map(id => document.getElementById(id))
      .filter(Boolean);
    const otherViews = ["view-cardgen", "view-storywriter", "view-roleplaychat", "view-adventure"]
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
      this._updatePlaygroundEditModelDropdown();
      this._updatePlaygroundCombineModelDropdown();
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
    // Attached to document (not just the view) because a paste event fires
    // wherever focus currently is — if nothing inside this view has been
    // clicked yet, that's document/body, which isn't a descendant of
    // viewPlayground, so a listener scoped to the view alone would miss it.
    // Guarded on the view actually being visible so this doesn't also fire
    // (alongside handleReferenceImagePaste, similarly unguarded) while on a
    // different tab. Routed by which paste zone currently has focus, since
    // the Combine tab has a second, independent image slot.
    document.addEventListener("paste", (e) => {
      if (viewPlayground.style.display === "none") return;
      if (document.activeElement?.id === "combine-image2-paste-zone") {
        this.handleCombineImage2Paste(e);
      } else {
        this.handlePlaygroundImagePaste(e);
      }
    });

    // Image 2 upload / paste (Combine tab)
    const combineImage2Input = document.getElementById("combine-image2-file");
    if (combineImage2Input) {
      combineImage2Input.addEventListener("change", (e) => this.handleCombineImage2Upload(e));
    }
    const combineImage2Zone = document.getElementById("combine-image2-paste-zone");
    if (combineImage2Zone && combineImage2Input) {
      combineImage2Zone.addEventListener("click", () => combineImage2Input.click());
    }

    // Tool tabs (Crop / Edit / Combine) — only one panel on screen at a
    // time. Crop embeds the same shared crop modal tool used elsewhere in
    // the app (see _relocateCropModal), opened the moment its tab is
    // selected. In-fill/Consistency/Expand tabs were cut in favor of just
    // using Edit with a good image-to-image model.
    ["crop", "edit", "combine"].forEach(tab => {
      const btn = document.getElementById(`pg-tab-${tab}`);
      if (btn) btn.addEventListener("click", () => this._setPlaygroundToolTab(tab));
    });

    const editBtn = document.getElementById("edit-playground-image-btn");
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditPlaygroundImage());

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

    // Edit model dropdown reads/writes the one api.image.editModel setting
    // (shared with the Settings text field too, see config.js).
    this._updatePlaygroundEditModelDropdown();
    const editModelSelect = document.getElementById("playground-edit-model");
    if (editModelSelect) {
      editModelSelect.addEventListener("change", (e) => this.config.set("api.image.editModel", e.target.value));
    }
  },

  // Switches which of the Crop / Edit / Combine panels is visible. Crop is
  // the shared modal tool (see image-cropper.js) embedded inline here —
  // opening it is what actually loads the current image into its canvas, so
  // selecting that tab triggers the same openCropModal('playground') a
  // button click used to.
  _setPlaygroundToolTab(tab) {
    this._pgActiveTab = tab;
    const tabs = { crop: "pg-tab-crop", edit: "pg-tab-edit", combine: "pg-tab-combine" };
    const panels = { crop: "pg-panel-crop", edit: "pg-panel-edit", combine: "pg-panel-combine" };

    Object.entries(tabs).forEach(([key, id]) => {
      const btn = document.getElementById(id);
      if (btn) btn.className = key === tab ? "btn-primary" : "btn-outline";
    });
    Object.entries(panels).forEach(([key, id]) => {
      const panel = document.getElementById(id);
      if (panel) panel.style.display = key === tab ? "block" : "none";
    });

    if (!this.playgroundImageUrl) return;
    if (tab === "crop") this.openCropModal('playground');
  },

  // Heuristic only — providers like nano-gpt list a plain text-to-image model
  // (e.g. z-image-turbo) right alongside its image-to-image variant
  // (z-image-turbo-image-to-image) with no other signal to tell them apart.
  // The plain one silently ignores the source image and free-generates from
  // the prompt instead — no error, just zero resemblance to the original.
  // This just flags models that don't look edit-capable by name so that
  // mistake is visible before spending a credit on it, not a guarantee.
  _looksEditCapable(modelId) {
    const id = (modelId || "").toLowerCase();
    return ["image-to-image", "img2img", "-edit", "edit-", "kontext", "inpaint", "instruct"]
      .some(marker => id.includes(marker));
  },

  // Populated from api.image.models — the same list "Fetch Models" in
  // Settings → Image API fills in (or the user adds to manually via its
  // "Add" button), since that endpoint returns every model the account has
  // access to, edit-capable or not.
  _updatePlaygroundEditModelDropdown(selectId = "playground-edit-model") {
    const select = document.getElementById(selectId);
    if (!select) return;

    const models = this.config.get("api.image.models") || [];
    const currentModel = this.config.get("api.image.editModel") || "";

    const label = (model) => this._looksEditCapable(model) ? model : `${model} ⚠️ may ignore your image`;

    if (models.length === 0) {
      const fallback = currentModel || "flux-2-pro-image-to-image";
      select.innerHTML = `<option value="${escapeHtml(fallback)}">${escapeHtml(label(fallback))}</option>`;
      return;
    }

    select.innerHTML = models
      .map(model => `<option value="${escapeHtml(model)}" ${model === currentModel ? "selected" : ""}>${escapeHtml(label(model))}</option>`)
      .join("");

    if (!models.includes(currentModel)) {
      select.value = models[0];
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
      this._addPlaygroundHistoryEntry(dataUrl, `Edited (${editModel})`);

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

  _addPlaygroundHistoryEntry(url, label) {
    if (!this.playgroundHistory) this.playgroundHistory = [];
    const last = this.playgroundHistory[this.playgroundHistory.length - 1];
    if (last && last.url === url) return; // avoid consecutive dupes (e.g. re-selecting the active entry)
    this.playgroundHistory.push({ url, label });
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
      thumb.title = entry.label;
      thumb.style.cssText = `
        flex: 0 0 auto; position: relative; width: 64px; height: 64px; cursor: pointer;
        border-radius: 0.5rem; overflow: hidden;
        border: 2px solid ${isActive ? "var(--accent)" : "var(--border)"};
      `;
      thumb.innerHTML = `
        <img src="${entry.url}" alt="${entry.label}" style="width: 100%; height: 100%; object-fit: cover; display: block;">
        <button type="button" data-save-index="${index}" title="Save this version to your device"
          style="position:absolute; bottom:0; right:0; border:none; background:rgba(0,0,0,0.55); color:#fff; font-size:0.7rem; line-height:1; padding:0.2rem 0.3rem; cursor:pointer;"
        >💾</button>
      `;
      thumb.addEventListener("click", (e) => {
        if (e.target.closest("[data-save-index]")) return;
        this._selectPlaygroundHistoryEntry(index);
      });
      const saveBtn = thumb.querySelector("[data-save-index]");
      if (saveBtn) {
        saveBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._savePlaygroundHistoryEntry(index);
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

  _savePlaygroundHistoryEntry(index) {
    const entry = this.playgroundHistory?.[index];
    if (!entry) return;
    const a = document.createElement("a");
    a.href = entry.url;
    a.download = `playground-image-${index + 1}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.showNotification("Image saved to your device.", "success");
  },

  // ── Two-image combining ──────────────────────────────────────────────────────
  // Unlike Edit (a single-image editImage() call), this needs a model that
  // accepts multiple reference images in one call
  // (apiHandler.combineImages, its own proxy route), which is a genuinely
  // different, less-common capability. Plain population, no
  // "looks edit-capable" heuristic (_looksEditCapable) — there's no reliable
  // naming convention for "accepts multiple images" the way "-image-to-image"
  // signals single-image editing.
  _updatePlaygroundCombineModelDropdown() {
    const select = document.getElementById("playground-combine-model");
    if (!select) return;

    const models = this.config.get("api.image.models") || [];
    const currentModel = this.config.get("api.image.combineModel") || "";

    if (models.length === 0) {
      select.innerHTML = `<option value="">No models configured — add one via Settings</option>`;
      return;
    }

    select.innerHTML = models
      .map(model => `<option value="${escapeHtml(model)}" ${model === currentModel ? "selected" : ""}>${escapeHtml(model)}</option>`)
      .join("");

    if (!models.includes(currentModel)) {
      select.value = models[0];
    }
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
      this._addPlaygroundHistoryEntry(dataUrl, `Combined (${combineModel})`);

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
