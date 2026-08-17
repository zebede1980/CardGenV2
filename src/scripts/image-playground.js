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

    // Crop / In-fill / Edit buttons
    const cropBtn = document.getElementById("crop-playground-image-btn");
    if (cropBtn) cropBtn.addEventListener("click", () => this.openCropModal('playground'));
    const inpaintBtn = document.getElementById("inpaint-playground-image-btn");
    if (inpaintBtn) inpaintBtn.addEventListener("click", () => this.openInfillModal('playground'));
    const editBtn = document.getElementById("edit-playground-image-btn");
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditPlaygroundImage());
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
  // there's no description field here. Unlike the card/reference edit flows,
  // this applies the result immediately rather than opening a compare-and-
  // choose modal: the history strip (_addPlaygroundHistoryEntry) already
  // keeps every prior version reachable, so the modal's only job — giving a
  // way back to "current" — is now redundant, and it was in the way of a
  // clean, quick "make a change, see it, make another" workflow.
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

    const editBtn = document.getElementById("edit-playground-image-btn");
    const statusEl = document.getElementById("playground-edit-status");
    if (editBtn) editBtn.disabled = true;
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.textContent = `✨ Editing with ${editModel}… this may take a minute.`;
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
          reader.onerror = () => reject(new Error("Failed to convert edited image to a data URL"));
          reader.readAsDataURL(blob);
        });
        if (isBlob) URL.revokeObjectURL(resultUrl);
      }

      this.playgroundImageUrl = dataUrl;
      this.updatePlaygroundImagePreview(dataUrl);
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();
      if (typeof this.updateInfillButtonVisibility === "function") this.updateInfillButtonVisibility();
      this._addPlaygroundHistoryEntry(dataUrl, `Edited (${editModel})`);

      this.showNotification("Image updated!", "success");
    } catch (error) {
      console.error("Playground image edit error:", error);
      this.showNotification(`✨ Edit failed: ${error.message}`, "error", 6000);
    } finally {
      if (editBtn) editBtn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
    }
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

});
