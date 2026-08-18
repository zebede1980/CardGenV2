// Image Playground — a standalone image-editing workspace with no card or
// character concept involved. Reuses the same crop/in-fill/edit tooling
// already generalized for the reference-image section (see image-cropper.js,
// image-infiller.js, image-handler.js's handleEditReferenceImage) via a third
// 'playground' target, working on this.playgroundImageUrl instead of a card's
// portrait or the pre-generation reference image.
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
      this._updatePlaygroundEditModelDropdown("playground-edit-model");
      this._updatePlaygroundEditModelDropdown("playground-consistency-model");
      this._updatePlaygroundCombineModelDropdown();
      const outpaintProviderSelect = document.getElementById("outpaint-provider");
      if (outpaintProviderSelect) {
        outpaintProviderSelect.value = this.config.get("api.image.infill.provider") || "localForge";
      }
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

    // Tool tabs (Crop / In-fill / Edit / Consistency / Expand) — only one
    // panel on screen at a time. Crop and In-fill embed the same shared
    // crop/in-fill modal tools used elsewhere in the app (see
    // _relocateCropModal/_relocateInfillModal), opened the moment their tab
    // is selected.
    ["crop", "infill", "edit", "consistency", "outpaint", "combine"].forEach(tab => {
      const btn = document.getElementById(`pg-tab-${tab}`);
      if (btn) btn.addEventListener("click", () => this._setPlaygroundToolTab(tab));
    });

    const editBtn = document.getElementById("edit-playground-image-btn");
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditPlaygroundImage());
    const consistencyBtn = document.getElementById("generate-consistency-image-btn");
    if (consistencyBtn) consistencyBtn.addEventListener("click", () => this.handleGenerateConsistentImage());

    // Outpaint's drag-frame tool (_openOutpaintTool) wires its own pointer
    // listeners lazily, the first time it's opened — see
    // _initOutpaintListenersOnce().
    const outpaintBtn = document.getElementById("outpaint-apply-btn");
    if (outpaintBtn) outpaintBtn.addEventListener("click", () => this.handleOutpaint());

    // Combine model dropdown — its own api.image.combineModel setting, not
    // synced with Edit/Consistency's api.image.editModel, since a model
    // that accepts multiple reference images is a different category from
    // one that just edits a single image.
    this._updatePlaygroundCombineModelDropdown();
    const combineModelSelect = document.getElementById("playground-combine-model");
    if (combineModelSelect) {
      combineModelSelect.addEventListener("change", (e) => this.config.set("api.image.combineModel", e.target.value));
    }
    const combineBtn = document.getElementById("combine-images-btn");
    if (combineBtn) combineBtn.addEventListener("click", () => this.handleCombineImages());

    // Edit and Consistency model dropdowns — both read/write the one
    // api.image.editModel setting (shared with the Settings text field too,
    // see config.js), so picking a model in either place updates all three.
    const modelSelectIds = ["playground-edit-model", "playground-consistency-model"];
    modelSelectIds.forEach(id => this._updatePlaygroundEditModelDropdown(id));
    modelSelectIds.forEach(id => {
      const select = document.getElementById(id);
      if (!select) return;
      select.addEventListener("change", (e) => {
        this.config.set("api.image.editModel", e.target.value);
        modelSelectIds
          .filter(otherId => otherId !== id)
          .forEach(otherId => this._updatePlaygroundEditModelDropdown(otherId));
      });
    });
  },

  // Switches which of the Crop / In-fill / Edit panels is visible. Crop and
  // In-fill are the shared modal tools (see image-cropper.js/image-infiller.js)
  // embedded inline here — opening them is what actually loads the current
  // image into their canvas, so selecting those tabs triggers the same
  // openCropModal('playground')/openInfillModal('playground') a button click
  // used to.
  _setPlaygroundToolTab(tab) {
    this._pgActiveTab = tab;
    const tabs = { crop: "pg-tab-crop", infill: "pg-tab-infill", edit: "pg-tab-edit", consistency: "pg-tab-consistency", outpaint: "pg-tab-outpaint", combine: "pg-tab-combine" };
    const panels = { crop: "pg-panel-crop", infill: "pg-panel-infill", edit: "pg-panel-edit", consistency: "pg-panel-consistency", outpaint: "pg-panel-outpaint", combine: "pg-panel-combine" };

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
    else if (tab === "infill") this.openInfillModal('playground');
    else if (tab === "outpaint") this._openOutpaintTool();
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
  // access to, edit-capable or not. Edit and Character Consistency each have
  // their own dropdown (selectId) but both read/write the one
  // api.image.editModel setting, so picking a model in either place updates
  // both — see the shared change listener in initPlaygroundTab().
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
      if (typeof this.updateInfillButtonVisibility === "function") this.updateInfillButtonVisibility();

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

  // Shared by the Edit and Character Consistency tabs — both are the exact
  // same image-to-image call (image + instruction → apiHandler.editImage()),
  // just aimed differently: Edit expects small, targeted changes; Consistency
  // expects a whole new scene/pose/style while using the image as an
  // identity anchor. There's no separate "consistency" API or model — same
  // mechanism either way, so this is one runner parameterized by which DOM
  // ids to read from and what to call the history entry.
  //
  // Applies the result immediately rather than opening a compare-and-choose
  // modal like the card/reference edit flows do: the history strip
  // (_addPlaygroundHistoryEntry) already keeps every prior version
  // reachable, so the modal's only job — giving a way back to "current" — is
  // redundant here, and it was in the way of a quick "try it, see it, try
  // again" workflow.
  async _runPlaygroundImageToImage({ instructionElId, modelSelectId, statusElId, buttonElId, allowLocalForge, historyLabel, missingInstructionMessage, successMessage }) {
    if (!this.playgroundImageUrl) {
      this.showNotification("Upload or paste an image first", "warning");
      return;
    }

    const instructionEl = document.getElementById(instructionElId);
    const instruction = instructionEl?.value?.trim();
    if (!instruction) {
      this.showNotification(missingInstructionMessage, "warning");
      instructionEl?.focus();
      return;
    }

    const useLocalForge = allowLocalForge && document.getElementById("playground-edit-use-forge")?.checked;
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
      editModel = document.getElementById(modelSelectId)?.value
        || this.config.get("api.image.editModel")
        || "flux-2-pro-image-to-image";
    }

    const actionBtn = document.getElementById(buttonElId);
    const statusEl = document.getElementById(statusElId);
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

      let dataUrl = resultUrl;
      if (!resultUrl.startsWith("data:")) {
        const isBlob = resultUrl.startsWith("blob:");
        const blob = isBlob
          ? await (await fetch(resultUrl)).blob()
          : await (await (window.authFetch || fetch)(`/api/proxy-image?url=${encodeURIComponent(resultUrl)}`)).blob();
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = () => reject(new Error("Failed to convert the result image to a data URL"));
          reader.readAsDataURL(blob);
        });
        if (isBlob) URL.revokeObjectURL(resultUrl);
      }

      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
      if (typeof this.updateInfillButtonVisibility === "function") this.updateInfillButtonVisibility();
      this._addPlaygroundHistoryEntry(dataUrl, historyLabel(editModel));

      this.showNotification(successMessage, "success");
    } catch (error) {
      console.error("Playground image-to-image error:", error);
      this.showNotification(`Failed: ${error.message}`, "error", 6000);
    } finally {
      if (actionBtn) actionBtn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
  },

  handleEditPlaygroundImage() {
    return this._runPlaygroundImageToImage({
      instructionElId: "playground-edit-instruction",
      modelSelectId: "playground-edit-model",
      statusElId: "playground-edit-status",
      buttonElId: "edit-playground-image-btn",
      allowLocalForge: true,
      historyLabel: (model) => `Edited (${model})`,
      missingInstructionMessage: "Describe what you want to change first",
      successMessage: "Image updated!",
    });
  },

  // Character Consistency: no Local Forge option here — flux-1-dev is a base
  // checkpoint, not an identity-preserving edit model, and per prior testing
  // (see cardgenv2-image-edit-feature memory) it loses facial likeness even
  // on small edits, so it'd be actively misleading to offer for a feature
  // whose entire point is keeping the face consistent through a big change.
  handleGenerateConsistentImage() {
    return this._runPlaygroundImageToImage({
      instructionElId: "playground-consistency-instruction",
      modelSelectId: "playground-consistency-model",
      statusElId: "playground-consistency-status",
      buttonElId: "generate-consistency-image-btn",
      allowLocalForge: false,
      historyLabel: (model) => `New scene (${model})`,
      missingInstructionMessage: "Describe the new scene first",
      successMessage: "New scene generated!",
    });
  },

  // ── History strip ──────────────────────────────────────────────────────────
  // Every version of the working image (original, plus after each crop/
  // in-fill/edit) as a non-destructive, click-to-revisit thumbnail strip —
  // this is what makes it safe to apply edits immediately above instead of
  // asking the user to confirm via a compare modal first.

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
    if (typeof this.updateInfillButtonVisibility === "function") this.updateInfillButtonVisibility();
    this._renderPlaygroundHistory();

    // If Crop, In-fill, or Expand is the open tab, reload its canvas with
    // the now-current image rather than leaving it showing a stale version.
    if (this._pgActiveTab === "crop") this.openCropModal('playground');
    else if (this._pgActiveTab === "infill") this.openInfillModal('playground');
    else if (this._pgActiveTab === "outpaint") this._openOutpaintTool();
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

  // ── Picture Expander (outpainting) ──────────────────────────────────────────
  // The inverse of Crop: instead of dragging a box inward to select what to
  // keep, drag a frame outward past the image's own edges to say how far to
  // extend the canvas. Reuses the same .crop-handle elements/CSS as the Crop
  // tool (see index.html #outpaint-frame), and the same drag-a-handle
  // mechanics as _initCropListenersOnce in image-cropper.js, just with the
  // clamp direction inverted — each edge is free to move between the
  // image's own edge (zero expansion) and the outer stage bound (max
  // expansion), rather than between 0 and the image's edge.
  //
  // Reuses apiHandler.inpaintImage() — the same call the In-fill tab uses —
  // for the actual fill, rather than any new provider integration. The mask
  // is generated from the frame's position instead of hand-painted.
  _outpaintState: {
    img: null,
    naturalW: 0, naturalH: 0,
    scale: 1, // natural px → stage px
    imgLeft: 0, imgTop: 0, imgW: 0, imgH: 0, // image's fixed position/size within the stage (stage px)
    stageW: 0, stageH: 0, // full interactive stage size — image plus max expansion room (stage px)
    frame: { left: 0, top: 0, right: 0, bottom: 0 }, // draggable frame's absolute edges (stage px)
    isDragging: false,
    dragHandle: null,
    dragStart: { x: 0, y: 0 },
    frameStart: { left: 0, top: 0, right: 0, bottom: 0 },
    listenersInitialized: false,
  },

  // How far either side can be dragged outward, as a multiple of the
  // image's own width/height — bounds the interactive stage size (and
  // worst-case payload) rather than allowing unlimited expansion. 1.0 means
  // a side can add up to 100% of that dimension.
  _OUTPAINT_MAX_EXPAND_FACTOR: 1.0,

  async _openOutpaintTool() {
    if (!this.playgroundImageUrl) return;

    const workspace = document.getElementById("outpaint-workspace");
    const stage = document.getElementById("outpaint-stage");
    const stageImg = document.getElementById("outpaint-stage-image");
    if (!workspace || !stage || !stageImg) return;

    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Failed to load the current image"));
        img.src = this.playgroundImageUrl;
      });

      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      const maxFactor = this._OUTPAINT_MAX_EXPAND_FACTOR;

      // Full interactive stage = image + max possible expansion on every
      // side, scaled to fit the visible workspace (same scale-to-fit
      // approach as _renderCropStage in image-cropper.js).
      const fullW = naturalW * (1 + 2 * maxFactor);
      const fullH = naturalH * (1 + 2 * maxFactor);
      const maxW = Math.max(50, (workspace.clientWidth || 600) - 8);
      const maxH = Math.max(50, (workspace.clientHeight || 400) - 8);
      const scale = Math.min(maxW / fullW, maxH / fullH, 1);

      const stageW = Math.round(fullW * scale);
      const stageH = Math.round(fullH * scale);
      const imgW = Math.round(naturalW * scale);
      const imgH = Math.round(naturalH * scale);
      const imgLeft = Math.round((stageW - imgW) / 2);
      const imgTop = Math.round((stageH - imgH) / 2);

      this._outpaintState.img = img;
      this._outpaintState.naturalW = naturalW;
      this._outpaintState.naturalH = naturalH;
      this._outpaintState.scale = scale;
      this._outpaintState.imgLeft = imgLeft;
      this._outpaintState.imgTop = imgTop;
      this._outpaintState.imgW = imgW;
      this._outpaintState.imgH = imgH;
      this._outpaintState.stageW = stageW;
      this._outpaintState.stageH = stageH;
      // Frame starts matching the image exactly — zero expansion until dragged.
      this._outpaintState.frame = { left: imgLeft, top: imgTop, right: imgLeft + imgW, bottom: imgTop + imgH };

      stage.style.width = `${stageW}px`;
      stage.style.height = `${stageH}px`;
      stageImg.src = this.playgroundImageUrl;
      stageImg.style.left = `${imgLeft}px`;
      stageImg.style.top = `${imgTop}px`;
      stageImg.style.width = `${imgW}px`;
      stageImg.style.height = `${imgH}px`;

      this._renderOutpaintFrame();
      this._initOutpaintListenersOnce();
      this._updateOutpaintSummary();
    } catch (error) {
      console.error("Outpaint tool load error:", error);
      this.showNotification(`Could not load the Expand tool: ${error.message}`, "error");
    }
  },

  _renderOutpaintFrame() {
    const frameEl = document.getElementById("outpaint-frame");
    if (!frameEl) return;
    const { left, top, right, bottom } = this._outpaintState.frame;
    frameEl.style.left = `${left}px`;
    frameEl.style.top = `${top}px`;
    frameEl.style.width = `${Math.max(0, right - left)}px`;
    frameEl.style.height = `${Math.max(0, bottom - top)}px`;
  },

  _initOutpaintListenersOnce() {
    if (this._outpaintState.listenersInitialized) return;
    this._outpaintState.listenersInitialized = true;

    const frameEl = document.getElementById("outpaint-frame");
    if (!frameEl) return;

    const onPointerDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const handleEl = e.target.closest(".crop-handle");
      if (!handleEl) return;

      e.preventDefault();
      e.stopPropagation();

      this._outpaintState.isDragging = true;
      this._outpaintState.dragHandle = handleEl.dataset.handle;
      this._outpaintState.dragStart = { x: e.clientX, y: e.clientY };
      this._outpaintState.frameStart = { ...this._outpaintState.frame };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!this._outpaintState.isDragging) return;

      const dx = e.clientX - this._outpaintState.dragStart.x;
      const dy = e.clientY - this._outpaintState.dragStart.y;
      const { dragHandle, frameStart, imgLeft, imgTop, imgW, imgH, stageW, stageH } = this._outpaintState;
      const imgRight = imgLeft + imgW;
      const imgBottom = imgTop + imgH;

      let { left, top, right, bottom } = frameStart;

      // Each edge is free between the image's own edge (0 expansion) and
      // the stage's outer bound (max expansion) — the exact inverse of
      // Crop's clamp, which keeps a box between 0 and the image's edge.
      if (dragHandle.includes("w")) left = Math.max(0, Math.min(imgLeft, frameStart.left + dx));
      if (dragHandle.includes("e")) right = Math.min(stageW, Math.max(imgRight, frameStart.right + dx));
      if (dragHandle.includes("n")) top = Math.max(0, Math.min(imgTop, frameStart.top + dy));
      if (dragHandle.includes("s")) bottom = Math.min(stageH, Math.max(imgBottom, frameStart.bottom + dy));

      this._outpaintState.frame = { left, top, right, bottom };
      this._renderOutpaintFrame();
      this._updateOutpaintSummary();
    };

    const onPointerUp = () => {
      this._outpaintState.isDragging = false;
      this._outpaintState.dragHandle = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    frameEl.addEventListener("pointerdown", onPointerDown);

    const resetBtn = document.getElementById("outpaint-reset-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        const { imgLeft, imgTop, imgW, imgH } = this._outpaintState;
        this._outpaintState.frame = { left: imgLeft, top: imgTop, right: imgLeft + imgW, bottom: imgTop + imgH };
        this._renderOutpaintFrame();
        this._updateOutpaintSummary();
      });
    }

    window.addEventListener("resize", () => {
      if (this._pgActiveTab === "outpaint" && this.playgroundImageUrl) {
        this._openOutpaintTool();
      }
    });
  },

  _updateOutpaintSummary() {
    const summaryEl = document.getElementById("outpaint-summary");
    const state = this._outpaintState;
    if (!summaryEl || !state.scale) return;

    const padLeft = Math.round((state.imgLeft - state.frame.left) / state.scale);
    const padRight = Math.round((state.frame.right - (state.imgLeft + state.imgW)) / state.scale);
    const padTop = Math.round((state.imgTop - state.frame.top) / state.scale);
    const padBottom = Math.round((state.frame.bottom - (state.imgTop + state.imgH)) / state.scale);

    if (!padLeft && !padRight && !padTop && !padBottom) {
      summaryEl.textContent = "Drag a handle outward to expand the canvas.";
      return;
    }

    const newW = state.naturalW + padLeft + padRight;
    const newH = state.naturalH + padTop + padBottom;
    summaryEl.textContent = `New size: ${newW} × ${newH}px (was ${state.naturalW} × ${state.naturalH}px)`;
  },

  async handleOutpaint() {
    if (!this.playgroundImageUrl) {
      this.showNotification("Upload or paste an image first", "warning");
      return;
    }

    const state = this._outpaintState;
    if (!state.img || !state.scale) {
      this.showNotification("Open the Expand tab first so the frame loads", "warning");
      return;
    }

    const padLeft = Math.max(0, Math.round((state.imgLeft - state.frame.left) / state.scale));
    const padRight = Math.max(0, Math.round((state.frame.right - (state.imgLeft + state.imgW)) / state.scale));
    const padTop = Math.max(0, Math.round((state.imgTop - state.frame.top) / state.scale));
    const padBottom = Math.max(0, Math.round((state.frame.bottom - (state.imgTop + state.imgH)) / state.scale));

    if (!padLeft && !padRight && !padTop && !padBottom) {
      this.showNotification("Drag the frame outward on at least one side first", "warning");
      return;
    }

    const chosenProvider = document.getElementById("outpaint-provider")?.value
      || this.config.get("api.image.infill.provider")
      || "localForge";
    const isCloudProvider = chosenProvider !== "localForge";
    const userPrompt = document.getElementById("outpaint-prompt")?.value?.trim() || "";

    const btn = document.getElementById("outpaint-apply-btn");
    const statusEl = document.getElementById("outpaint-status");
    if (btn) btn.disabled = true;
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `🖼️ Expanding with ${chosenProvider === "localForge" ? "Local Forge" : "the In-fill API"}… this may take a minute.`;
    }

    try {
      const img = state.img;
      let drawW = img.naturalWidth;
      let drawH = img.naturalHeight;
      let padL = padLeft, padR = padRight, padT = padTop, padB = padBottom;

      // Cloud providers reject oversized payloads (413) — scale the whole
      // expanded canvas down uniformly, same cap _getInfillPayloadData uses.
      if (isCloudProvider) {
        const rawTargetW = drawW + padL + padR;
        const rawTargetH = drawH + padT + padB;
        if (Math.max(rawTargetW, rawTargetH) > 1024) {
          const scaleDown = 1024 / Math.max(rawTargetW, rawTargetH);
          drawW = Math.round(drawW * scaleDown);
          drawH = Math.round(drawH * scaleDown);
          padL = Math.round(padL * scaleDown);
          padR = Math.round(padR * scaleDown);
          padT = Math.round(padT * scaleDown);
          padB = Math.round(padB * scaleDown);
        }
      }

      const targetW = drawW + padL + padR;
      const targetH = drawH + padT + padB;

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(img, padL, padT, drawW, drawH);
      const imageDataUrl = isCloudProvider ? canvas.toDataURL("image/jpeg", 0.92) : canvas.toDataURL("image/png");

      // Mask convention differs by provider — this is also the fix for why
      // outpainting previously just left the new area plain white instead
      // of filling it in via the cloud provider:
      //   - Local Forge (Stable Diffusion): opaque grayscale, white=inpaint,
      //     black=keep (see _getInfillPayloadData in image-infiller.js).
      //   - Cloud (OpenAI images/edits convention, which nano-gpt's
      //     inpaint-capable models also follow): the mask's ALPHA channel
      //     is what matters — transparent (alpha 0) = edit, opaque = keep.
      //     An all-opaque mask (which is what a solid black/white PNG with
      //     no transparency is) tells that endpoint "nothing to edit," so
      //     it just handed the source image back — no error, just a no-op,
      //     which looked exactly like "it just added white."
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = targetW;
      maskCanvas.height = targetH;
      const maskCtx = maskCanvas.getContext("2d");
      let maskDataUrl;
      if (isCloudProvider) {
        maskCtx.clearRect(0, 0, targetW, targetH); // transparent everywhere = "edit everywhere"...
        maskCtx.fillStyle = "#ffffff";
        maskCtx.fillRect(padL, padT, drawW, drawH); // ...except the original image's bounds, kept opaque
        maskDataUrl = maskCanvas.toDataURL("image/png");
      } else {
        maskCtx.fillStyle = "#ffffff";
        maskCtx.fillRect(0, 0, targetW, targetH);
        maskCtx.fillStyle = "#000000";
        maskCtx.fillRect(padL, padT, drawW, drawH);
        maskDataUrl = maskCanvas.toDataURL("image/png");
      }

      const resultUrl = await this.apiHandler.inpaintImage({
        imageBase64: imageDataUrl,
        maskBase64: maskDataUrl,
        prompt: userPrompt || "seamlessly continue the surrounding scene, matching style and lighting",
        providerOverride: chosenProvider,
        width: targetW,
        height: targetH,
      });

      if (!resultUrl) {
        throw new Error("No image was returned from the in-fill provider");
      }

      const dataUrl = await this._urlToDataUrl(resultUrl);
      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
      if (typeof this.updateInfillButtonVisibility === "function") this.updateInfillButtonVisibility();
      this._addPlaygroundHistoryEntry(dataUrl, `Expanded (+${padLeft}/${padTop}/${padRight}/${padBottom}px L/T/R/B)`);

      this.showNotification("Canvas expanded!", "success");
      // Reload the tool against the new image so another expansion pass can
      // start from here, matching Crop/In-fill's "stay open" behavior.
      this._openOutpaintTool();
    } catch (error) {
      console.error("Outpaint error:", error);
      this.showNotification(`Expand failed: ${error.message}`, "error", 6000);
    } finally {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
  },

  // ── Two-image combining ──────────────────────────────────────────────────────
  // Unlike Edit/Consistency/Outpaint, this can't reuse editImage() or
  // inpaintImage() — it needs a model that accepts multiple reference images
  // in one call (apiHandler.combineImages, its own proxy route), which is a
  // genuinely different, less-common capability. Plain population, no
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
      if (typeof this.updateInfillButtonVisibility === "function") this.updateInfillButtonVisibility();
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
