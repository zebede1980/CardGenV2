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
    // different tab.
    document.addEventListener("paste", (e) => {
      if (viewPlayground.style.display === "none") return;
      this.handlePlaygroundImagePaste(e);
    });

    // Tool tabs (Crop / In-fill / Edit / Consistency / Expand) — only one
    // panel on screen at a time. Crop and In-fill embed the same shared
    // crop/in-fill modal tools used elsewhere in the app (see
    // _relocateCropModal/_relocateInfillModal), opened the moment their tab
    // is selected.
    ["crop", "infill", "edit", "consistency", "outpaint"].forEach(tab => {
      const btn = document.getElementById(`pg-tab-${tab}`);
      if (btn) btn.addEventListener("click", () => this._setPlaygroundToolTab(tab));
    });

    const editBtn = document.getElementById("edit-playground-image-btn");
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditPlaygroundImage());
    const consistencyBtn = document.getElementById("generate-consistency-image-btn");
    if (consistencyBtn) consistencyBtn.addEventListener("click", () => this.handleGenerateConsistentImage());

    // Outpaint controls
    ["top", "bottom", "left", "right"].forEach(side => {
      const btn = document.getElementById(`outpaint-side-${side}`);
      if (btn) {
        btn.addEventListener("click", () => {
          btn.classList.toggle("active");
          this._updateOutpaintSummary();
        });
      }
    });
    const outpaintPercent = document.getElementById("outpaint-percent");
    if (outpaintPercent) {
      outpaintPercent.addEventListener("input", (e) => {
        const label = document.getElementById("outpaint-percent-val");
        if (label) label.textContent = `${e.target.value}%`;
        this._updateOutpaintSummary();
      });
    }
    const outpaintBtn = document.getElementById("outpaint-apply-btn");
    if (outpaintBtn) outpaintBtn.addEventListener("click", () => this.handleOutpaint());
    this._updateOutpaintSummary();

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
    const tabs = { crop: "pg-tab-crop", infill: "pg-tab-infill", edit: "pg-tab-edit", consistency: "pg-tab-consistency", outpaint: "pg-tab-outpaint" };
    const panels = { crop: "pg-panel-crop", infill: "pg-panel-infill", edit: "pg-panel-edit", consistency: "pg-panel-consistency", outpaint: "pg-panel-outpaint" };

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

    // If Crop or In-fill is the open tab, reload its canvas with the
    // now-current image rather than leaving it showing a stale version.
    if (this._pgActiveTab === "crop") this.openCropModal('playground');
    else if (this._pgActiveTab === "infill") this.openInfillModal('playground');
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
  // Reuses apiHandler.inpaintImage() — the same call the In-fill tab uses —
  // rather than any new provider integration. The only difference from a
  // hand-painted in-fill is that the mask here is generated programmatically:
  // paste the original image onto a larger blank canvas, then mask
  // everything outside its original bounds as "fill" (white) and the
  // original bounds as "keep" (black) — see _getInfillPayloadData in
  // image-infiller.js for the same black/white convention.

  _updateOutpaintSummary() {
    const summaryEl = document.getElementById("outpaint-summary");
    if (!summaryEl) return;

    const percent = Number(document.getElementById("outpaint-percent")?.value) || 25;
    const sides = ["top", "bottom", "left", "right"]
      .filter(side => document.getElementById(`outpaint-side-${side}`)?.classList.contains("active"));

    if (sides.length === 0) {
      summaryEl.textContent = "Pick at least one side to expand.";
      return;
    }

    const widthPct = (sides.includes("left") ? percent : 0) + (sides.includes("right") ? percent : 0);
    const heightPct = (sides.includes("top") ? percent : 0) + (sides.includes("bottom") ? percent : 0);
    const parts = [];
    if (widthPct) parts.push(`+${widthPct}% width`);
    if (heightPct) parts.push(`+${heightPct}% height`);
    summaryEl.textContent = `New canvas: ${parts.join(", ")}`;
  },

  async handleOutpaint() {
    if (!this.playgroundImageUrl) {
      this.showNotification("Upload or paste an image first", "warning");
      return;
    }

    const sides = ["top", "bottom", "left", "right"]
      .filter(side => document.getElementById(`outpaint-side-${side}`)?.classList.contains("active"));
    if (sides.length === 0) {
      this.showNotification("Pick at least one side to expand", "warning");
      return;
    }

    const expandPercent = Number(document.getElementById("outpaint-percent")?.value) || 25;
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
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Failed to load the current image"));
        img.src = this.playgroundImageUrl;
      });

      let padTop = sides.includes("top") ? Math.round(img.naturalHeight * expandPercent / 100) : 0;
      let padBottom = sides.includes("bottom") ? Math.round(img.naturalHeight * expandPercent / 100) : 0;
      let padLeft = sides.includes("left") ? Math.round(img.naturalWidth * expandPercent / 100) : 0;
      let padRight = sides.includes("right") ? Math.round(img.naturalWidth * expandPercent / 100) : 0;
      let drawW = img.naturalWidth;
      let drawH = img.naturalHeight;

      // Cloud providers reject oversized payloads (413) — scale the whole
      // expanded canvas down uniformly, same cap _getInfillPayloadData uses.
      if (isCloudProvider) {
        const rawTargetW = drawW + padLeft + padRight;
        const rawTargetH = drawH + padTop + padBottom;
        if (Math.max(rawTargetW, rawTargetH) > 1024) {
          const scale = 1024 / Math.max(rawTargetW, rawTargetH);
          drawW = Math.round(drawW * scale);
          drawH = Math.round(drawH * scale);
          padTop = Math.round(padTop * scale);
          padBottom = Math.round(padBottom * scale);
          padLeft = Math.round(padLeft * scale);
          padRight = Math.round(padRight * scale);
        }
      }

      const targetW = drawW + padLeft + padRight;
      const targetH = drawH + padTop + padBottom;

      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.drawImage(img, padLeft, padTop, drawW, drawH);
      const imageDataUrl = isCloudProvider ? canvas.toDataURL("image/jpeg", 0.92) : canvas.toDataURL("image/png");

      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = targetW;
      maskCanvas.height = targetH;
      const maskCtx = maskCanvas.getContext("2d");
      maskCtx.fillStyle = "#ffffff"; // fill everywhere...
      maskCtx.fillRect(0, 0, targetW, targetH);
      maskCtx.fillStyle = "#000000"; // ...except the original image's bounds
      maskCtx.fillRect(padLeft, padTop, drawW, drawH);
      const maskDataUrl = maskCanvas.toDataURL("image/png");

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
      this._addPlaygroundHistoryEntry(dataUrl, `Expanded (+${expandPercent}% ${sides.join("/")})`);

      this.showNotification("Canvas expanded!", "success");
    } catch (error) {
      console.error("Outpaint error:", error);
      this.showNotification(`Expand failed: ${error.message}`, "error", 6000);
    } finally {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
  },

});
