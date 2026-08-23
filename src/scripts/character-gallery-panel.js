// Character Gallery Panel — the Character Generator screen's UI for managing
// a saved card's extra linked images (separate from the single portrait).
// The images themselves are fetched/rendered here; scrolling through them
// full-screen is handled by openGallery() in image-gallery.js.
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
    this._pendingGalleryImageBase64 = null;
    const preview = document.getElementById("gallery-generate-preview");
    if (preview) preview.style.display = "none";
  },

  async handleGalleryGenerate() {
    if (!this.currentCharacter || !this.currentCardId) return;

    const imageApiBase = this.config.get("api.image.baseUrl");
    const imageApiKey = this.config.get("api.image.apiKey");
    if (!imageApiBase || !imageApiKey) {
      this.showNotification("Please configure image API settings first", "warning");
      return;
    }

    const btn = document.getElementById("gallery-generate-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }

    try {
      const cardType = this.currentCharacter?.cardType || document.getElementById("card-type-select")?.value || "single";
      const customPrompt = document.getElementById("custom-image-prompt")?.value?.trim() || null;
      const model = this.config.get("api.image.model") || "";

      const imageUrl = await window.apiHandler.generateImage(
        this.currentCharacter.description,
        this.currentCharacter.name,
        customPrompt,
        model,
        cardType,
        undefined,
        typeof this._getGuidance === "function" ? this._getGuidance() : "",
      );

      let displayUrl = imageUrl;
      if (imageUrl && !imageUrl.startsWith("blob:") && !imageUrl.startsWith("data:")) {
        const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
        const response = await (window.authFetch || fetch)(proxyUrl);
        if (response.ok) {
          const blob = await response.blob();
          displayUrl = URL.createObjectURL(blob);
        }
      }

      let dataUrl = displayUrl;
      if (displayUrl && displayUrl.startsWith("blob:")) {
        const blob = await (await fetch(displayUrl)).blob();
        dataUrl = await this.storage.blobToBase64(blob);
      }

      this._pendingGalleryImageBase64 = dataUrl;
      const preview = document.getElementById("gallery-generate-preview");
      const previewImg = document.getElementById("gallery-generate-preview-img");
      if (previewImg) previewImg.src = dataUrl;
      if (preview) preview.style.display = "block";
    } catch (error) {
      console.error("Gallery image generation failed:", error);
      this.showNotification(`Image generation failed: ${error.message}`, "error");
    } finally {
      if (btn) { btn.disabled = !this.currentCardId; btn.textContent = "✨ Generate"; }
    }
  },

  async handleGalleryGenerateAccept() {
    const preview = document.getElementById("gallery-generate-preview");
    if (this._pendingGalleryImageBase64) {
      await this._addCharacterGalleryImage(this._pendingGalleryImageBase64);
    }
    this._pendingGalleryImageBase64 = null;
    if (preview) preview.style.display = "none";
  },

  handleGalleryGenerateDiscard() {
    this._pendingGalleryImageBase64 = null;
    const preview = document.getElementById("gallery-generate-preview");
    if (preview) preview.style.display = "none";
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
