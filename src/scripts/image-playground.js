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

    // Crop / In-fill / Edit buttons
    const cropBtn = document.getElementById("crop-playground-image-btn");
    if (cropBtn) cropBtn.addEventListener("click", () => this.openCropModal('playground'));
    const inpaintBtn = document.getElementById("inpaint-playground-image-btn");
    if (inpaintBtn) inpaintBtn.addEventListener("click", () => this.openInfillModal('playground'));
    const editBtn = document.getElementById("edit-playground-image-btn");
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditPlaygroundImage());

    // Model Guide
    const guideSelect = document.getElementById("playground-guide-task");
    if (guideSelect) {
      guideSelect.addEventListener("change", () => this._renderPlaygroundGuideResult());
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

      const editSection = document.getElementById("playground-edit-section");
      if (editSection) editSection.style.display = "block";
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

  // Same image-to-image editing as handleEditReferenceImage(), targeting
  // this.playgroundImageUrl instead — no vision re-describe step since
  // there's no description field here. See handleEditReferenceImage() in
  // image-handler.js for why this is its own function rather than a
  // target-branch of handleEditImage().
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
      editModel = this.config.get("api.image.editModel") || "flux-2-pro-image-to-image";
    }

    this.openImageOptionsModal();
    const modalTitle = document.querySelector("#image-options-modal .modal-title");
    if (modalTitle) modalTitle.innerHTML = "✨ Edit Image";

    const grid = document.getElementById("image-options-grid");
    const loading = document.getElementById("image-options-loading");
    const loadingText = loading.querySelector("p");
    if (loadingText) loadingText.textContent = `Editing image with ${editModel}… this may take a minute.`;

    grid.innerHTML = "";
    loading.style.display = "block";

    try {
      const imageBase64 = this.playgroundImageUrl;
      const originalUrl = this.playgroundImageUrl;

      const resultUrl = useLocalForge
        ? await window.apiHandler.editForgeImage({ imageBase64, instruction, denoisingStrength })
        : await window.apiHandler.editImage({ imageBase64, instruction, model: editModel });

      let blobUrl = resultUrl;
      if (!resultUrl.startsWith("blob:") && !resultUrl.startsWith("data:")) {
        const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(resultUrl)}`;
        const response = await (window.authFetch || fetch)(proxyUrl);
        if (response.ok) blobUrl = URL.createObjectURL(await response.blob());
      }

      loading.style.display = "none";

      const currentWrapper = document.createElement("div");
      currentWrapper.style.cssText = "cursor:pointer;border:2px solid var(--success);border-radius:0.5rem;overflow:hidden;transition:box-shadow 0.2s;background:var(--surface-color);position:relative;";
      currentWrapper.onmouseenter = () => { currentWrapper.style.boxShadow = "0 0 0 4px rgba(31,157,102,0.22)"; };
      currentWrapper.onmouseleave = () => { currentWrapper.style.boxShadow = ""; };
      currentWrapper.onclick = () => {
        this.closeImageOptionsModal();
        this.showNotification("Keeping original image.", "info");
      };
      currentWrapper.innerHTML = `
        <div style="position:absolute;top:0.5rem;left:0.5rem;background:var(--success);color:#fff;font-size:0.7rem;font-weight:700;padding:0.2rem 0.55rem;border-radius:999px;z-index:1;letter-spacing:0.04em;">CURRENT</div>
        <img src="${originalUrl}" style="width:100%;height:auto;display:block;" alt="Current image">
        <div style="padding:0.75rem;text-align:center;background:rgba(31,157,102,0.08);border-top:1px solid var(--border);">
          <button class="btn-outline" style="width:100%;border-color:var(--success);color:var(--success);">✓ Keep This</button>
        </div>
      `;
      grid.appendChild(currentWrapper);

      const mt = document.querySelector("#image-options-modal .modal-title");
      if (mt) mt.innerHTML = "✨ Compare & Choose — Edited Image";

      const newWrapper = document.createElement("div");
      newWrapper.style.cssText = "cursor:pointer;border:2px solid transparent;border-radius:0.5rem;overflow:hidden;transition:border-color 0.2s;background:var(--surface-color);width:100%;position:relative;";
      newWrapper.onmouseenter = () => (newWrapper.style.border = "2px solid var(--accent)");
      newWrapper.onmouseleave = () => (newWrapper.style.border = "2px solid transparent");
      newWrapper.onclick = async () => {
        this.closeImageOptionsModal();

        let dataUrl = blobUrl;
        if (!dataUrl.startsWith("data:")) {
          const resp = await (window.authFetch || fetch)(blobUrl);
          const blob = await resp.blob();
          dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error("Failed to convert edited image to a data URL"));
            reader.readAsDataURL(blob);
          });
        }

        this.playgroundImageUrl = dataUrl;
        if (typeof this.updatePlaygroundImagePreview === "function") {
          this.updatePlaygroundImagePreview(dataUrl);
        }
        if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
        if (typeof this.updateInfillButtonVisibility === "function") this.updateInfillButtonVisibility();
        this.showNotification("Image updated!", "success");
      };
      newWrapper.innerHTML = `
        <div style="position:absolute;top:0.5rem;left:0.5rem;background:var(--accent);color:#fff;font-size:0.7rem;font-weight:700;padding:0.2rem 0.55rem;border-radius:999px;z-index:1;letter-spacing:0.04em;">NEW</div>
        <img src="${blobUrl}" style="width: 100%; height: auto; display: block;" alt="Edited image">
        <div style="padding: 1rem; text-align: center; background: rgba(0,0,0,0.1); border-top: 1px solid var(--border);">
          <button class="btn-primary" style="width: 100%;">Use This Image</button>
          <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.4rem;">✨ ${editModel}</div>
        </div>
      `;
      grid.appendChild(newWrapper);

      this._makeImageGalleryable(grid, [{ url: blobUrl, prompt: instruction, model: editModel, label: "Edited" }], 'playground');

      this.openImageOptionsModal();
      this.showNotification("Image edited! Compare and choose.", "success");
    } catch (error) {
      console.error("Playground image edit error:", error);
      loading.style.display = "none";
      this.closeImageOptionsModal();
      this.showNotification(`✨ Edit failed: ${error.message}`, "error", 6000);
    }
  },

  // ── Model Guide ────────────────────────────────────────────────────────────
  // Static, curated recommendations from what's actually been tested this
  // project (see cardgenv2-image-edit-feature memory) — deliberately NOT a
  // dynamic/AI-driven predictor. Model behavior (especially safety-filter
  // behavior) is empirical and drifts as providers update their models, so
  // this is meant to be hand-edited as more gets learned, not computed.
  _PLAYGROUND_MODEL_GUIDE: {
    outfit_pose: {
      recommend: "flux-2-pro-image-to-image",
      text: "For outfit or pose changes, flux-2-pro-image-to-image (or flux-2-max-image-to-image) gave the strongest identity preservation in testing — same face, hair, and background carried through cleanly.",
    },
    style_transfer: {
      recommend: "flux-2-pro-image-to-image",
      text: "For style transfer (e.g. anime → photorealistic), flux-2-pro-image-to-image handled the conversion well while keeping the character recognizable. flux-kontext works too but is pickier about source content (see below).",
    },
    general_edit: {
      recommend: "flux-2-pro-image-to-image",
      text: "For general small edits, flux-2-pro-image-to-image is a solid default. flux-kontext is a good alternative if the source image is fully clothed.",
    },
    mature_content: {
      recommend: "flux-2-pro-image-to-image",
      text: "If the source image shows skin/nudity: flux-kontext silently hard-blocks (returns a solid-black image, no error) — avoid it here. flux-2-pro-image-to-image and flux-2-max-image-to-image handle these sources without blocking, but tend to auto-cover exposed skin in the result rather than editing it faithfully — expect the output to look more modest than the input.",
    },
  },

  _renderPlaygroundGuideResult() {
    const select = document.getElementById("playground-guide-task");
    const resultEl = document.getElementById("playground-guide-result");
    if (!select || !resultEl) return;

    const entry = this._PLAYGROUND_MODEL_GUIDE[select.value];
    if (!entry) {
      resultEl.innerHTML = "";
      return;
    }

    resultEl.innerHTML = `
      <p style="margin: 0 0 0.5rem;">${entry.text}</p>
      <button type="button" id="playground-guide-use-model-btn" class="btn-small" data-model="${entry.recommend}">
        Use "${entry.recommend}" as my Image Edit Model
      </button>
    `;

    const useBtn = document.getElementById("playground-guide-use-model-btn");
    if (useBtn) {
      useBtn.addEventListener("click", () => {
        this.config.set("api.image.editModel", entry.recommend);
        this.showNotification(`Image Edit Model set to "${entry.recommend}"`, "success");
      });
    }
  },

});
