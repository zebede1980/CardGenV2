// Image Gallery / Lightbox Module — extends CharacterGeneratorApp prototype
// Full-screen image viewer with zoom, pan, keyboard nav, and download
Object.assign(CharacterGeneratorApp.prototype, {

  /* ── State ──────────────────────────────────────────────────────────────── */
  _galleryImages: [],      // Array of { url, prompt, model, label, index }
  _galleryCurrentIdx: 0,
  _galleryScale: 1,
  _galleryPanX: 0,
  _galleryPanY: 0,
  _galleryIsPanning: false,
  _galleryPanStartX: 0,
  _galleryPanStartY: 0,
  _galleryPanOrigX: 0,
  _galleryPanOrigY: 0,

  /* ── Open / Close ──────────────────────────────────────────────────────── */

  openGallery(images, startIdx = 0) {
    if (!images || images.length === 0) return;
    this._galleryImages = images;
    this._galleryCurrentIdx = Math.max(0, Math.min(startIdx, images.length - 1));
    this._galleryScale = 1;
    this._galleryPanX = 0;
    this._galleryPanY = 0;

    const overlay = document.getElementById("gallery-lightbox");
    if (!overlay) return;
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
    overlay.setAttribute("aria-hidden", "false");

    this._renderGalleryImage();
    this._bindGalleryEvents();
    this._updateGalleryCounter();
  },

  closeGallery() {
    const overlay = document.getElementById("gallery-lightbox");
    if (!overlay) return;
    overlay.classList.remove("show");
    document.body.style.overflow = "";
    overlay.setAttribute("aria-hidden", "true");
    this._unbindGalleryEvents();
  },

  /* ── Render ────────────────────────────────────────────────────────────── */

  _renderGalleryImage() {
    const img = this._galleryImages[this._galleryCurrentIdx];
    if (!img) return;

    const imgEl = document.getElementById("gallery-image");
    const metaEl = document.getElementById("gallery-meta");
    if (!imgEl || !metaEl) return;

    // Reset transform
    this._galleryScale = 1;
    this._galleryPanX = 0;
    this._galleryPanY = 0;
    this._applyGalleryTransform();

    imgEl.src = img.url;
    imgEl.alt = img.label || img.model || "Generated Image";

    // Show metadata
    const model = img.model || "Unknown model";
    const prompt = img.prompt || "";
    const snippet = prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt;
    metaEl.innerHTML = `
      <span class="gallery-meta-model">${escapeHtml(model)}</span>
      ${snippet ? `<span class="gallery-meta-prompt" title="${escapeHtml(prompt)}">${escapeHtml(snippet)}</span>` : ""}
    `;

    this._updateGalleryCounter();
    this._updateGalleryNavButtons();
  },

  _applyGalleryTransform() {
    const container = document.getElementById("gallery-image-container");
    if (!container) return;
    const img = container.querySelector("img");
    if (!img) return;
    img.style.transform = `scale(${this._galleryScale}) translate(${this._galleryPanX / this._galleryScale}px, ${this._galleryPanY / this._galleryScale}px)`;
    img.style.cursor = this._galleryScale > 1 ? (this._galleryIsPanning ? "grabbing" : "grab") : "default";
  },

  _updateGalleryCounter() {
    const counter = document.getElementById("gallery-counter");
    if (counter) {
      counter.textContent = `${this._galleryCurrentIdx + 1}/${this._galleryImages.length}`;
    }
  },

  _updateGalleryNavButtons() {
    const prevBtn = document.getElementById("gallery-prev-btn");
    const nextBtn = document.getElementById("gallery-next-btn");
    if (prevBtn) prevBtn.style.display = this._galleryCurrentIdx <= 0 ? "none" : "";
    if (nextBtn) nextBtn.style.display = this._galleryCurrentIdx >= this._galleryImages.length - 1 ? "none" : "";
  },

  /* ── Navigation ────────────────────────────────────────────────────────── */

  _galleryPrev() {
    if (this._galleryCurrentIdx > 0) {
      this._galleryCurrentIdx--;
      this._renderGalleryImage();
    }
  },

  _galleryNext() {
    if (this._galleryCurrentIdx < this._galleryImages.length - 1) {
      this._galleryCurrentIdx++;
      this._renderGalleryImage();
    }
  },

  _galleryZoomIn() {
    this._galleryScale = Math.min(5, this._galleryScale + 0.25);
    this._applyGalleryTransform();
  },

  _galleryZoomOut() {
    this._galleryScale = Math.max(0.25, this._galleryScale - 0.25);
    if (this._galleryScale <= 1) {
      this._galleryPanX = 0;
      this._galleryPanY = 0;
    }
    this._applyGalleryTransform();
  },

  _galleryDownload() {
    const img = this._galleryImages[this._galleryCurrentIdx];
    if (!img || !img.url) return;
    const a = document.createElement("a");
    a.href = img.url;
    a.download = `cardgen-image-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    this.showNotification("Image download started", "info");
  },

  _galleryUse() {
    const img = this._galleryImages[this._galleryCurrentIdx];
    if (!img || !img.url) return;
    // Mimics selectImageOption but keeps gallery images alive
    if (this.closeImageOptionsModal) this.closeImageOptionsModal();
    this.closeGallery();

    if (this.currentImageUrl && this.currentImageUrl.startsWith("blob:") && this.currentImageUrl !== img.url) {
      URL.revokeObjectURL(this.currentImageUrl);
    }

    this.currentImageUrl = img.url;

    const imageContainer = document.getElementById("image-content");
    if (imageContainer && window.imageGenerator) {
      imageContainer.innerHTML = window.imageGenerator.formatImageForDisplay(img.url);
    }

    const customPromptTextarea = document.getElementById("custom-image-prompt");
    if (customPromptTextarea && img.prompt) {
      customPromptTextarea.value = img.prompt;
      if (window.updatePromptCharCount) window.updatePromptCharCount();
    }

    if (img.model) {
      const activeImageModelSelect = document.getElementById("active-image-model");
      if (activeImageModelSelect) {
        activeImageModelSelect.value = img.model;
        this.config.set("api.image.model", img.model);
      }
    }

    this.showNotification("Image applied to card!", "success");
    this.saveCardToLibrary().catch(() => {});
    this.refreshLibraryViews().catch(() => {});
  },

  /* ── Events ────────────────────────────────────────────────────────────── */

  _bindGalleryEvents() {
    this._onGalleryKey = (e) => {
      switch (e.key) {
        case "Escape": this.closeGallery(); break;
        case "ArrowLeft": this._galleryPrev(); break;
        case "ArrowRight": this._galleryNext(); break;
        case "+":
        case "=": this._galleryZoomIn(); break;
        case "-": this._galleryZoomOut(); break;
      }
    };
    document.addEventListener("keydown", this._onGalleryKey);

    const container = document.getElementById("gallery-image-container");
    if (!container) return;

    // Mouse wheel zoom
    this._onGalleryWheel = (e) => {
      e.preventDefault();
      if (e.deltaY < 0) this._galleryZoomIn();
      else this._galleryZoomOut();
    };
    container.addEventListener("wheel", this._onGalleryWheel, { passive: false });

    // Pan start
    this._onGalleryMouseDown = (e) => {
      if (this._galleryScale <= 1) return;
      e.preventDefault();
      this._galleryIsPanning = true;
      this._galleryPanStartX = e.clientX;
      this._galleryPanStartY = e.clientY;
      this._galleryPanOrigX = this._galleryPanX;
      this._galleryPanOrigY = this._galleryPanY;
      this._applyGalleryTransform();
    };
    container.addEventListener("mousedown", this._onGalleryMouseDown);

    // Pan move
    this._onGalleryMouseMove = (e) => {
      if (!this._galleryIsPanning) return;
      this._galleryPanX = this._galleryPanOrigX + (e.clientX - this._galleryPanStartX);
      this._galleryPanY = this._galleryPanOrigY + (e.clientY - this._galleryPanStartY);
      this._applyGalleryTransform();
    };
    window.addEventListener("mousemove", this._onGalleryMouseMove);

    // Pan end
    this._onGalleryMouseUp = () => {
      this._galleryIsPanning = false;
      this._applyGalleryTransform();
    };
    window.addEventListener("mouseup", this._onGalleryMouseUp);

    // Touch support — pinch to zoom & two-finger pan
    let lastTouchDist = 0;
    let lastTouchScale = 1;
    this._onGalleryTouchStart = (e) => {
      if (e.touches.length === 2) {
        lastTouchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        lastTouchScale = this._galleryScale;
      } else if (e.touches.length === 1 && this._galleryScale > 1) {
        this._galleryIsPanning = true;
        this._galleryPanStartX = e.touches[0].clientX;
        this._galleryPanStartY = e.touches[0].clientY;
        this._galleryPanOrigX = this._galleryPanX;
        this._galleryPanOrigY = this._galleryPanY;
      }
    };
    container.addEventListener("touchstart", this._onGalleryTouchStart, { passive: false });

    this._onGalleryTouchMove = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        if (lastTouchDist > 0) {
          const newScale = Math.min(5, Math.max(0.25, lastTouchScale * (dist / lastTouchDist)));
          this._galleryScale = newScale;
          if (newScale <= 1) { this._galleryPanX = 0; this._galleryPanY = 0; }
          this._applyGalleryTransform();
        }
      } else if (e.touches.length === 1 && this._galleryIsPanning) {
        this._galleryPanX = this._galleryPanOrigX + (e.touches[0].clientX - this._galleryPanStartX);
        this._galleryPanY = this._galleryPanOrigY + (e.touches[0].clientY - this._galleryPanStartY);
        this._applyGalleryTransform();
      }
    };
    container.addEventListener("touchmove", this._onGalleryTouchMove, { passive: false });

    this._onGalleryTouchEnd = () => {
      this._galleryIsPanning = false;
      lastTouchDist = 0;
    };
    window.addEventListener("touchend", this._onGalleryTouchEnd);

    // Click on overlay backdrop to close
    this._onGalleryOverlayClick = (e) => {
      if (e.target === document.getElementById("gallery-lightbox")) {
        this.closeGallery();
      }
    };
    document.getElementById("gallery-lightbox")?.addEventListener("click", this._onGalleryOverlayClick);

    // Button bindings
    const btnBind = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", handler);
    };
    btnBind("gallery-close-btn", () => this.closeGallery());
    btnBind("gallery-prev-btn", () => this._galleryPrev());
    btnBind("gallery-next-btn", () => this._galleryNext());
    btnBind("gallery-zoom-in-btn", () => this._galleryZoomIn());
    btnBind("gallery-zoom-out-btn", () => this._galleryZoomOut());
    btnBind("gallery-download-btn", () => this._galleryDownload());
    btnBind("gallery-use-btn", () => this._galleryUse());
  },

  _unbindGalleryEvents() {
    if (this._onGalleryKey) document.removeEventListener("keydown", this._onGalleryKey);
    if (this._onGalleryWheel) document.getElementById("gallery-image-container")?.removeEventListener("wheel", this._onGalleryWheel);
    if (this._onGalleryMouseDown) document.getElementById("gallery-image-container")?.removeEventListener("mousedown", this._onGalleryMouseDown);
    if (this._onGalleryMouseMove) window.removeEventListener("mousemove", this._onGalleryMouseMove);
    if (this._onGalleryMouseUp) window.removeEventListener("mouseup", this._onGalleryMouseUp);
    if (this._onGalleryTouchStart) document.getElementById("gallery-image-container")?.removeEventListener("touchstart", this._onGalleryTouchStart);
    if (this._onGalleryTouchMove) document.getElementById("gallery-image-container")?.removeEventListener("touchmove", this._onGalleryTouchMove);
    if (this._onGalleryTouchEnd) window.removeEventListener("touchend", this._onGalleryTouchEnd);
    if (this._onGalleryOverlayClick) document.getElementById("gallery-lightbox")?.removeEventListener("click", this._onGalleryOverlayClick);
  },

  /* ── Helper: make an image list openable in the gallery ────────────────── */
  // Call this from image-handler to attach gallery triggers to image cards
  _makeImageGalleryable(gridContainer, images) {
    if (!gridContainer || !images || images.length === 0) return;

    const cards = gridContainer.querySelectorAll("[data-gallery-image]");
    // Already tagged — skip
    if (cards.length > 0) return;

    // Find all direct child image wrappers (divs containing <img>)
    const wrappers = gridContainer.querySelectorAll(":scope > div");
    wrappers.forEach((wrapper, i) => {
      if (i >= images.length) return;
      // Skip the "CURRENT" keep-card
      if (wrapper.querySelector('[style*="CURRENT"]')) return;

      // Already has gallery trigger?
      if (wrapper.dataset.galleryImage === "true") return;
      wrapper.dataset.galleryImage = "true";

      // Add magnifying glass overlay
      const zoomBtn = document.createElement("button");
      zoomBtn.className = "gallery-zoom-trigger";
      zoomBtn.innerHTML = "🔍";
      zoomBtn.title = "View in gallery";
      zoomBtn.style.cssText =
        "position:absolute;top:0.5rem;right:0.5rem;z-index:2;background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:50%;width:2rem;height:2rem;font-size:0.9rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.15s,background 0.15s;";
      zoomBtn.addEventListener("mouseenter", () => { zoomBtn.style.transform = "scale(1.15)"; zoomBtn.style.background = "var(--accent)"; });
      zoomBtn.addEventListener("mouseleave", () => { zoomBtn.style.transform = "scale(1)"; zoomBtn.style.background = "rgba(0,0,0,0.55)"; });
      zoomBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openGallery(images, i);
      });
      wrapper.appendChild(zoomBtn);
    });
  },

});
