// Character Gallery Panel — the Character Generator screen's UI for managing
// a saved card's extra linked images (separate from the single portrait).
// The images themselves are fetched/rendered here; scrolling through them
// full-screen is handled by openGallery() in image-gallery.js.

// Always prepended to the user's typed instruction in handleGalleryGenerate()
// so gallery additions can never drift into a different-looking character no
// matter what's typed — the source portrait is an identity anchor, not just
// a style reference.
const GALLERY_CONSISTENCY_INSTRUCTION =
  "Keep this exact character's face, identity, hairstyle, and defining features fully consistent with the source image. Only change what is described next:";

Object.assign(CharacterGeneratorApp.prototype, {

  async _renderCharacterGalleryPanel() {
    const strip = document.getElementById("character-gallery-strip");
    const hint = document.getElementById("character-gallery-hint");
    const generateBtn = document.getElementById("gallery-generate-btn");
    const uploadBtn = document.getElementById("gallery-upload-btn");
    if (!strip) return;

    const cardId = this.currentCardId;
    const isRealCard = !!cardId && !String(cardId).startsWith("h_");

    if (generateBtn) generateBtn.disabled = !isRealCard;
    if (uploadBtn) uploadBtn.disabled = !isRealCard;
    if (hint) hint.style.display = isRealCard ? "none" : "block";

    strip.innerHTML = "";
    this._characterGalleryImages = [];
    if (!isRealCard || !this.storage) return;

    const rows = await this.storage.listGalleryImages(cardId);
    const token = window.cardgenAuth?.getToken() || localStorage.getItem("cardgen_auth_token") || "";
    this._characterGalleryImages = rows.map((row) => ({
      id: row.id,
      url: `${row.url}?token=${encodeURIComponent(token)}`,
    }));

    this._characterGalleryImages.forEach((img, idx) => {
      strip.appendChild(this._buildGalleryThumb(img, idx));
    });
  },

  _buildGalleryThumb(img, idx) {
    const strip = document.getElementById("character-gallery-strip");
    const thumb = document.createElement("div");
    thumb.className = "character-gallery-thumb";
    thumb.draggable = true;
    thumb.dataset.galleryId = String(img.id);

    const imgEl = document.createElement("img");
    imgEl.src = img.url;
    imgEl.alt = "Gallery image";
    imgEl.addEventListener("click", () => {
      this.openGallery(this._characterGalleryImages.map((g) => ({ url: g.url })), idx);
    });
    thumb.appendChild(imgEl);

    const delBtn = document.createElement("button");
    delBtn.className = "gallery-thumb-delete";
    delBtn.innerHTML = "×";
    delBtn.title = "Remove from gallery";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._deleteCharacterGalleryImage(img.id);
    });
    thumb.appendChild(delBtn);

    thumb.addEventListener("dragstart", (e) => {
      thumb.classList.add("dragging");
      e.dataTransfer.setData("text/plain", String(img.id));
      e.dataTransfer.effectAllowed = "move";
    });
    thumb.addEventListener("dragend", () => thumb.classList.remove("dragging"));
    thumb.addEventListener("dragover", (e) => e.preventDefault());
    thumb.addEventListener("drop", (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData("text/plain");
      if (!draggedId || draggedId === String(img.id) || !strip) return;
      const draggedEl = strip.querySelector(`[data-gallery-id="${draggedId}"]`);
      if (!draggedEl) return;
      const rect = thumb.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      strip.insertBefore(draggedEl, before ? thumb : thumb.nextSibling);
      this._persistCharacterGalleryOrder();
    });

    return thumb;
  },

  async _persistCharacterGalleryOrder() {
    const strip = document.getElementById("character-gallery-strip");
    if (!strip || !this.currentCardId) return;
    const orderedIds = Array.from(strip.children).map((el) => Number(el.dataset.galleryId));
    try {
      await this.storage.reorderGalleryImages(this.currentCardId, orderedIds);
      const byId = new Map(this._characterGalleryImages.map((g) => [g.id, g]));
      this._characterGalleryImages = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    } catch (e) {
      console.error("Failed to persist gallery order:", e);
      this.showNotification("Failed to save new gallery order", "error");
      this._renderCharacterGalleryPanel();
    }
  },

  async _deleteCharacterGalleryImage(galleryId) {
    if (!confirm("Remove this image from the gallery?")) return;
    try {
      await this.storage.deleteGalleryImage(this.currentCardId, galleryId);
      await this._renderCharacterGalleryPanel();
    } catch (e) {
      console.error("Failed to remove gallery image:", e);
      this.showNotification(`Failed to remove image: ${e.message}`, "error");
    }
  },

  async _addCharacterGalleryImage(dataUrl) {
    if (!this.currentCardId) return;
    try {
      await this.storage.addGalleryImage(this.currentCardId, dataUrl);
      this.showNotification("Added to gallery", "success");
      await this._renderCharacterGalleryPanel();
    } catch (e) {
      console.error("Failed to add gallery image:", e);
      this.showNotification(`Failed to add gallery image: ${e.message}`, "error");
    }
  },

  _clearCharacterGallery() {
    const strip = document.getElementById("character-gallery-strip");
    const hint = document.getElementById("character-gallery-hint");
    const generateBtn = document.getElementById("gallery-generate-btn");
    const uploadBtn = document.getElementById("gallery-upload-btn");
    if (strip) strip.innerHTML = "";
    if (hint) hint.style.display = "block";
    if (generateBtn) generateBtn.disabled = true;
    if (uploadBtn) uploadBtn.disabled = true;
    this._characterGalleryImages = [];
    this._pendingGalleryImages = [];
    this._renderGalleryGeneratePreview();
  },

  // Rebuilds the #gallery-generate-instructions box list to match Count
  // (1/2/4, see #gallery-generate-count) — each generated image gets its own
  // independent instruction rather than one prompt shared across the whole
  // batch, so a Count-of-4 run can be 4 different poses/scenes in one go.
  // Preserves already-typed text across a count change (e.g. 2 -> 4 keeps
  // the first two boxes as they were) instead of wiping everything.
  _renderGalleryInstructionInputs() {
    const container = document.getElementById("gallery-generate-instructions");
    if (!container) return;
    const count = parseInt(document.getElementById("gallery-generate-count")?.value, 10) || 1;

    const existingValues = Array.from(container.querySelectorAll(".gallery-instruction-input")).map((el) => el.value);

    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const row = document.createElement("div");
      row.style.cssText = "display: flex; gap: 0.5rem; align-items: flex-start;";

      if (count > 1) {
        const label = document.createElement("span");
        label.textContent = `${i + 1}.`;
        label.style.cssText = "font-size: 0.75rem; color: var(--text-secondary); padding-top: 0.55rem; min-width: 1.1rem;";
        row.appendChild(label);
      }

      const textarea = document.createElement("textarea");
      textarea.className = "input gallery-instruction-input";
      textarea.rows = 2;
      textarea.maxLength = 1000;
      textarea.placeholder = count > 1
        ? `Image ${i + 1} — e.g. sitting by a campfire at night, same character`
        : "Describe the new pose/scene/outfit — e.g. sitting by a campfire at night, same character | wearing a blue dress, waving";
      textarea.value = existingValues[i] || "";
      row.appendChild(textarea);

      container.appendChild(row);
    }
  },

  // Image-to-image from the card's current portrait (not a fresh
  // text-to-image roll from the character description, which is what this
  // used to do) — GALLERY_CONSISTENCY_INSTRUCTION is always prepended to
  // every instruction so results stay recognizably this character regardless
  // of what's typed. One independent edit call per instruction box, run in
  // parallel.
  async handleGalleryGenerate() {
    if (!this.currentCharacter || !this.currentCardId) return;
    if (!this.currentImageUrl) {
      this.showNotification("This character needs a portrait image first", "warning");
      return;
    }

    const instructionEls = Array.from(document.querySelectorAll("#gallery-generate-instructions .gallery-instruction-input"));
    const instructions = instructionEls.map((el) => el.value.trim());
    const emptyIndex = instructions.findIndex((text) => !text);
    if (emptyIndex !== -1) {
      this.showNotification(
        instructions.length > 1 ? `Describe image #${emptyIndex + 1} first` : "Describe the new pose/scene/outfit first",
        "warning"
      );
      instructionEls[emptyIndex]?.focus();
      return;
    }

    const imageApiBase = this.config.get("api.image.baseUrl");
    const imageApiKey = this.config.get("api.image.apiKey");
    if (!imageApiBase || !imageApiKey) {
      this.showNotification("Please configure image API settings first", "warning");
      return;
    }

    const editModel = this.config.get("api.image.editModel") || "flux-2-pro-image-to-image";
    const count = instructions.length;

    const btn = document.getElementById("gallery-generate-btn");
    if (btn) { btn.disabled = true; btn.textContent = count > 1 ? `Generating ${count}…` : "Generating..."; }

    try {
      const sourceBlob = await this.imageGenerator.convertToBlob(this.currentImageUrl);
      const imageBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read current image"));
        reader.readAsDataURL(sourceBlob);
      });

      const results = await Promise.allSettled(
        instructions.map((instruction) =>
          window.apiHandler.editImage({
            imageBase64,
            instruction: `${GALLERY_CONSISTENCY_INSTRUCTION} ${instruction}`,
            model: editModel,
          })
        )
      );

      const dataUrls = [];
      let failures = 0;
      for (const result of results) {
        if (result.status !== "fulfilled") {
          failures++;
          console.error("Gallery generate error:", result.reason);
          continue;
        }
        dataUrls.push(await this._urlToDataUrl(result.value));
      }

      if (dataUrls.length === 0) {
        throw results.find((r) => r.status === "rejected")?.reason || new Error("Image generation failed");
      }

      this._pendingGalleryImages = dataUrls;
      this._renderGalleryGeneratePreview();

      if (failures > 0) {
        this.showNotification(`Generated ${dataUrls.length} of ${count} (${failures} failed)`, "warning");
      }
    } catch (error) {
      console.error("Gallery image generation failed:", error);
      this.showNotification(`Image generation failed: ${error.message}`, "error");
    } finally {
      if (btn) { btn.disabled = !this.currentCardId; btn.textContent = "✨ Generate"; }
    }
  },

  // Renders one card per pending generated image, each with its own
  // Add/Discard — needed once Count above can produce more than one result
  // at a time.
  _renderGalleryGeneratePreview() {
    const preview = document.getElementById("gallery-generate-preview");
    const list = document.getElementById("gallery-generate-preview-list");
    if (!preview || !list) return;

    const images = this._pendingGalleryImages || [];
    if (images.length === 0) {
      preview.style.display = "none";
      list.innerHTML = "";
      return;
    }

    preview.style.display = "block";
    list.innerHTML = "";
    images.forEach((dataUrl, index) => {
      const item = document.createElement("div");
      item.style.cssText = "width: 140px; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--surface-muted);";
      item.innerHTML = `
        <img src="${dataUrl}" alt="Generated preview ${index + 1}" style="width: 100%; height: 140px; object-fit: cover; display: block;" />
        <div style="display: flex; gap: 0.3rem; padding: 0.4rem;">
          <button type="button" class="btn-primary btn-small" style="flex: 1; font-size: 0.7rem; padding: 0.3rem;" data-gallery-accept-index="${index}">✔️ Add</button>
          <button type="button" class="btn-outline btn-small" style="flex: 1; font-size: 0.7rem; padding: 0.3rem;" data-gallery-discard-index="${index}">✖️</button>
        </div>
      `;
      list.appendChild(item);
    });
  },

  async handleGalleryGenerateAcceptOne(index) {
    const dataUrl = this._pendingGalleryImages?.[index];
    if (!dataUrl) return;
    await this._addCharacterGalleryImage(dataUrl);
    this._pendingGalleryImages.splice(index, 1);
    this._renderGalleryGeneratePreview();
  },

  handleGalleryGenerateDiscardOne(index) {
    if (!this._pendingGalleryImages) return;
    this._pendingGalleryImages.splice(index, 1);
    this._renderGalleryGeneratePreview();
  },

  async handleGalleryGenerateAcceptAll() {
    const images = this._pendingGalleryImages || [];
    for (const dataUrl of images) {
      await this._addCharacterGalleryImage(dataUrl);
    }
    this._pendingGalleryImages = [];
    this._renderGalleryGeneratePreview();
  },

  handleGalleryGenerateDiscard() {
    this._pendingGalleryImages = [];
    this._renderGalleryGeneratePreview();
  },

  async handleGalleryUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !this.currentCardId) return;
    try {
      const dataUrl = await this.storage.blobToBase64(file);
      await this._addCharacterGalleryImage(dataUrl);
    } catch (e) {
      console.error("Failed to upload gallery image:", e);
      this.showNotification(`Failed to upload image: ${e.message}`, "error");
    }
  },

});
