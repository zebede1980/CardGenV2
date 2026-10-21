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

  // context: 'card' (default — "Use This" applies to this.currentImageUrl),
  // 'reference' (applies to this.referenceImageDataUrl instead), or
  // 'galleryPending' (an unsaved Gallery Generate candidate — see
  // _renderGalleryGeneratePreview in character-gallery-panel.js). Needed
  // because the gallery's own "✓ Use This" button (_galleryUse) is a
  // separate accept path from the compare-and-choose card's own click
  // handler, and was hardcoded to the card image — see _galleryUse() for
  // the branch. 'galleryPending' also reveals a Discard button so a
  // candidate can be accepted/rejected at full size, not just from its
  // small thumbnail.
  openGallery(images, startIdx = 0, context = 'card') {
    if (!images || images.length === 0) return;
    this._galleryImages = images;
    this._galleryContext = context;
    this._galleryCurrentIdx = Math.max(0, Math.min(startIdx, images.length - 1));
    this._galleryScale = 1;
    this._galleryPanX = 0;
    this._galleryPanY = 0;

    const overlay = document.getElementById("gallery-lightbox");
    if (!overlay) return;
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
    overlay.setAttribute("aria-hidden", "false");

    const useBtn = document.getElementById("gallery-use-btn");
    if (useBtn) {
      useBtn.title = context === 'reference' ? "Use This as the Reference Image"
        : context === 'galleryPending' ? "Add This Image to the Gallery"
        : context === 'playgroundLibrary' ? "Start a New Character from This Image"
        : context === 'playgroundHistory' ? "Make This Version the Working Image"
        : "Use This Image for Card";
      useBtn.textContent = context === 'galleryPending' ? "✔️ Add to Gallery"
        : context === 'playgroundLibrary' ? "🎭 New Character"
        : context === 'playgroundHistory' ? "↩ Make Current"
        : "✓ Use This";
    }
    const discardBtn = document.getElementById("gallery-lightbox-discard-btn");
    if (discardBtn) discardBtn.style.display = context === 'galleryPending' ? "" : "none";

    this._renderGalleryImage();
    this._bindGalleryEvents();
    this._updateGalleryCounter();
  },

  closeGallery() {
    const overlay = document.getElementById("gallery-lightbox");
    if (!overlay) return;
    
    // Remove focus from any gallery buttons to prevent ARIA warnings when hidden
    if (document.activeElement && overlay.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    
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

    // Show metadata — whatever is known about the image, or nothing at all
    // (a bare "Unknown model" bar over a portrait just hides part of it).
    const heading = img.model || img.label || "";
    const prompt = img.prompt || "";
    const snippet = prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt;
    metaEl.innerHTML = `
      ${heading ? `<span class="gallery-meta-model">${escapeHtml(heading)}</span>` : ""}
      ${snippet ? `<span class="gallery-meta-prompt" title="${escapeHtml(prompt)}">${escapeHtml(snippet)}</span>` : ""}
    `;
    metaEl.style.display = heading || snippet ? "" : "none";

    // 'view' is look-only: the image is already where it is being used.
    // 'playgroundHistory' has nothing to do for the version already current.
    const useBtn = document.getElementById("gallery-use-btn");
    if (useBtn) {
      const hideUse = this._galleryContext === 'view'
        || (this._galleryContext === 'playgroundHistory' && img.url === this.playgroundImageUrl);
      useBtn.style.display = hideUse ? "none" : "";
    }

    this._updateGalleryCounter();
    this._updateGalleryNavButtons();
  },

  _applyGalleryTransform() {
    const container = document.getElementById("gallery-image-container");
    if (!container) return;
    const img = container.querySelector("img");
    if (!img) return;
    this._clampGalleryPan();
    img.style.transform = `scale(${this._galleryScale}) translate(${this._galleryPanX / this._galleryScale}px, ${this._galleryPanY / this._galleryScale}px)`;
    img.style.cursor = this._galleryScale > 1 ? (this._galleryIsPanning ? "grabbing" : "grab") : "zoom-in";
  },

  // Keeps a zoomed image covering the screen: it can be dragged until an edge
  // meets the screen's edge, never off into the dark. Uses the image's
  // untransformed size (offsetWidth ignores transforms).
  _clampGalleryPan() {
    const img = document.getElementById("gallery-image");
    if (!img || this._galleryScale <= 1) {
      this._galleryPanX = 0;
      this._galleryPanY = 0;
      return;
    }
    const maxX = Math.max(0, (img.offsetWidth * this._galleryScale - window.innerWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * this._galleryScale - window.innerHeight) / 2);
    this._galleryPanX = Math.max(-maxX, Math.min(maxX, this._galleryPanX));
    this._galleryPanY = Math.max(-maxY, Math.min(maxY, this._galleryPanY));
  },

  // The image's centre when unzoomed. The container is laid out around the
  // image and transforms don't move layout, so its box is the resting box.
  _galleryRestCentre() {
    const rect = document.getElementById("gallery-image-container")?.getBoundingClientRect();
    if (!rect) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },

  // Zooms so the point of the image under (clientX, clientY) stays put —
  // under the fingers, the cursor or the double-tap. No point means the
  // middle of the screen (the toolbar buttons).
  _galleryZoomTo(scale, clientX, clientY) {
    const next = Math.max(this._GALLERY_MIN_SCALE, Math.min(this._GALLERY_MAX_SCALE, scale));
    const c = this._galleryRestCentre();
    const qx = (clientX ?? window.innerWidth / 2) - c.x;
    const qy = (clientY ?? window.innerHeight / 2) - c.y;
    const ratio = next / this._galleryScale;
    this._galleryPanX = qx - ratio * (qx - this._galleryPanX);
    this._galleryPanY = qy - ratio * (qy - this._galleryPanY);
    this._galleryScale = next;
    this._applyGalleryTransform();
  },

  _GALLERY_MIN_SCALE: 1,
  _GALLERY_MAX_SCALE: 5,
  _GALLERY_DOUBLE_TAP_SCALE: 2.5,

  // Double-tap / double-click: zoom in on that spot, or back out if zoomed.
  _galleryToggleZoom(clientX, clientY) {
    if (this._galleryScale > 1) this._galleryZoomTo(1);
    else this._galleryZoomTo(this._GALLERY_DOUBLE_TAP_SCALE, clientX, clientY);
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

  _galleryZoomIn(clientX, clientY) {
    this._galleryZoomTo(this._galleryScale * 1.25, clientX, clientY);
  },

  _galleryZoomOut(clientX, clientY) {
    this._galleryZoomTo(this._galleryScale / 1.25, clientX, clientY);
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

  async _galleryUse() {
    const img = this._galleryImages[this._galleryCurrentIdx];
    if (!img || !img.url) return;

    if (this._galleryContext === 'galleryPending') {
      // Index into this._pendingGalleryImages, not a saved card/reference
      // image — accept this one candidate and let the panel re-render.
      const idx = this._galleryCurrentIdx;
      this.closeGallery();
      if (typeof this.handleGalleryGenerateAcceptOne === "function") {
        await this.handleGalleryGenerateAcceptOne(idx);
      }
      return;
    }

    if (this._galleryContext === 'playgroundHistory') {
      const idx = (this.playgroundHistory || []).findIndex((e) => e.url === img.url);
      this.closeGallery();
      if (idx >= 0) this._selectPlaygroundHistoryEntry(idx);
      return;
    }

    if (this._galleryContext === 'view') return;

    if (this._galleryContext === 'playgroundLibrary') {
      // Same action as the tile's "🎭 New character" button — the row, not the
      // token-carrying display URL, is what that flow needs.
      const row = (this._playgroundLibraryRows || [])[this._galleryCurrentIdx];
      this.closeGallery();
      if (row && typeof this.sendPlaygroundImageToNewCharacter === "function") {
        await this.sendPlaygroundImageToNewCharacter(row);
      }
      return;
    }

    // Mimics selectImageOption but keeps gallery images alive
    if (this.closeImageOptionsModal) this.closeImageOptionsModal();
    this.closeGallery();

    if (this._galleryContext === 'reference') {
      // Reference image path: no card exists yet. Needs a real data: URL
      // (not blob:/remote) since it gets re-sent to the vision model.
      let dataUrl = img.url;
      if (typeof this._urlToDataUrl === "function") {
        try {
          dataUrl = await this._urlToDataUrl(img.url);
        } catch (e) {
          console.error("Gallery use (reference): failed to convert image to data URL", e);
        }
      }

      this.referenceImageDataUrl = dataUrl;
      if (typeof this.updateReferenceImagePreview === "function") {
        this.updateReferenceImagePreview(dataUrl);
      }
      if (typeof this.updateCropButtonVisibility === "function") this.updateCropButtonVisibility();

      this.showNotification("Reference image updated. Re-describing…", "success");

      if (typeof this.apiHandler?.describeReferenceImage === "function") {
        try {
          const descriptionField = document.getElementById("reference-image-description");
          const hint = descriptionField?.value?.trim() || "";
          const imageDescription = await this.apiHandler.describeReferenceImage(dataUrl, hint);
          if (descriptionField) descriptionField.value = imageDescription;
          this.showNotification("Reference image description updated", "success");
        } catch (descErr) {
          console.error("Re-describe after gallery use failed:", descErr);
          this.showNotification(`Could not re-describe image: ${descErr.message}`, "warning");
        }
      }
      return;
    }

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

  // Only reachable when context is 'galleryPending' — the button itself is
  // hidden otherwise (see openGallery()).
  _galleryDiscardPending() {
    if (this._galleryContext !== 'galleryPending') return;
    const idx = this._galleryCurrentIdx;
    this.closeGallery();
    if (typeof this.handleGalleryGenerateDiscardOne === "function") {
      this.handleGalleryGenerateDiscardOne(idx);
    }
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

    // Mouse wheel zoom, centred on the cursor
    this._onGalleryWheel = (e) => {
      e.preventDefault();
      if (e.deltaY < 0) this._galleryZoomIn(e.clientX, e.clientY);
      else this._galleryZoomOut(e.clientX, e.clientY);
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

    // Desktop double-click. Touch double-taps are handled in touchend, and a
    // browser that also synthesises dblclick from them is ignored here.
    this._onGalleryDblClick = (e) => {
      if (Date.now() - (this._galleryLastTouchAt || 0) < 800) return;
      this._galleryToggleZoom(e.clientX, e.clientY);
    };
    container.addEventListener("dblclick", this._onGalleryDblClick);

    // Touch: pinch zooms around the point between the fingers (and moving
    // both fingers pans); one finger pans when zoomed, swipes to the
    // previous/next image when not; a double-tap toggles zoom on that spot.
    // The container has touch-action: none, so Safari's own page zoom and
    // double-tap zoom stay out of it.
    let pinch = null;
    let swipe = null;
    let lastTap = null;
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    this._onGalleryTouchStart = (e) => {
      this._galleryLastTouchAt = Date.now();
      if (e.touches.length === 2) {
        e.preventDefault();
        swipe = null;
        this._galleryIsPanning = false;
        const c = this._galleryRestCentre();
        const m = mid(e.touches);
        // The image point under the fingers, in unzoomed pixels from its centre.
        pinch = {
          dist: dist(e.touches) || 1,
          scale: this._galleryScale,
          ux: (m.x - c.x - this._galleryPanX) / this._galleryScale,
          uy: (m.y - c.y - this._galleryPanY) / this._galleryScale,
        };
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        swipe = { x: t.clientX, y: t.clientY, at: Date.now(), moved: false };
        if (this._galleryScale > 1) {
          this._galleryIsPanning = true;
          this._galleryPanStartX = t.clientX;
          this._galleryPanStartY = t.clientY;
          this._galleryPanOrigX = this._galleryPanX;
          this._galleryPanOrigY = this._galleryPanY;
        }
      }
    };
    container.addEventListener("touchstart", this._onGalleryTouchStart, { passive: false });

    this._onGalleryTouchMove = (e) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinch) {
        const c = this._galleryRestCentre();
        const m = mid(e.touches);
        const scale = Math.max(this._GALLERY_MIN_SCALE, Math.min(this._GALLERY_MAX_SCALE, pinch.scale * (dist(e.touches) / pinch.dist)));
        this._galleryScale = scale;
        this._galleryPanX = m.x - c.x - scale * pinch.ux;
        this._galleryPanY = m.y - c.y - scale * pinch.uy;
        this._applyGalleryTransform();
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        if (swipe && Math.hypot(t.clientX - swipe.x, t.clientY - swipe.y) > 10) swipe.moved = true;
        if (this._galleryIsPanning) {
          this._galleryPanX = this._galleryPanOrigX + (t.clientX - this._galleryPanStartX);
          this._galleryPanY = this._galleryPanOrigY + (t.clientY - this._galleryPanStartY);
          this._applyGalleryTransform();
        }
      }
    };
    container.addEventListener("touchmove", this._onGalleryTouchMove, { passive: false });

    this._onGalleryTouchEnd = (e) => {
      if (!document.getElementById("gallery-lightbox")?.classList.contains("show")) return;
      this._galleryLastTouchAt = Date.now();
      if (e.touches.length > 0) {
        // One finger lifted out of a pinch: carry on panning with the other.
        pinch = null;
        if (e.touches.length === 1 && this._galleryScale > 1) {
          const t = e.touches[0];
          this._galleryIsPanning = true;
          this._galleryPanStartX = t.clientX;
          this._galleryPanStartY = t.clientY;
          this._galleryPanOrigX = this._galleryPanX;
          this._galleryPanOrigY = this._galleryPanY;
        }
        return;
      }
      const wasPinch = !!pinch;
      pinch = null;
      this._galleryIsPanning = false;
      this._applyGalleryTransform();

      const t = e.changedTouches?.[0];
      if (!swipe || !t || wasPinch) { swipe = null; return; }
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      const quick = Date.now() - swipe.at < 600;
      if (this._galleryScale <= 1 && quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) this._galleryNext();
        else this._galleryPrev();
        lastTap = null;
      } else if (!swipe.moved) {
        const now = Date.now();
        if (lastTap && now - lastTap.at < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
          this._galleryToggleZoom(t.clientX, t.clientY);
          lastTap = null;
        } else {
          lastTap = { x: t.clientX, y: t.clientY, at: now };
        }
      }
      swipe = null;
    };
    container.addEventListener("touchend", this._onGalleryTouchEnd);
    container.addEventListener("touchcancel", this._onGalleryTouchEnd);

    // Older iOS Safari pinch-zooms the page from gesture events even when
    // the touches themselves are cancelled.
    this._onGalleryGesture = (e) => e.preventDefault();
    container.addEventListener("gesturestart", this._onGalleryGesture);
    container.addEventListener("gesturechange", this._onGalleryGesture);

    // Click on overlay backdrop to close
    this._onGalleryOverlayClick = (e) => {
      if (e.target === document.getElementById("gallery-lightbox")) {
        this.closeGallery();
      }
    };
    document.getElementById("gallery-lightbox")?.addEventListener("click", this._onGalleryOverlayClick);

    // Button bindings — bound once ever, not per-open. These handlers read
    // current state (this._galleryImages/_galleryCurrentIdx) at click-time
    // rather than capturing anything from this particular open(), so they
    // never needed rebinding on reopen. They used to be re-added on every
    // openGallery() call with no matching removal in _unbindGalleryEvents(),
    // so after opening the lightbox N times in a session, Prev/Next (and
    // every other button here) fired N times per click — silently skipping
    // over images and making some of them unreachable.
    if (!this._galleryStaticButtonsBound) {
      this._galleryStaticButtonsBound = true;
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
      btnBind("gallery-lightbox-discard-btn", () => this._galleryDiscardPending());
    }
  },

  _unbindGalleryEvents() {
    if (this._onGalleryKey) document.removeEventListener("keydown", this._onGalleryKey);
    if (this._onGalleryWheel) document.getElementById("gallery-image-container")?.removeEventListener("wheel", this._onGalleryWheel);
    if (this._onGalleryMouseDown) document.getElementById("gallery-image-container")?.removeEventListener("mousedown", this._onGalleryMouseDown);
    if (this._onGalleryMouseMove) window.removeEventListener("mousemove", this._onGalleryMouseMove);
    if (this._onGalleryMouseUp) window.removeEventListener("mouseup", this._onGalleryMouseUp);
    if (this._onGalleryTouchStart) document.getElementById("gallery-image-container")?.removeEventListener("touchstart", this._onGalleryTouchStart);
    if (this._onGalleryTouchMove) document.getElementById("gallery-image-container")?.removeEventListener("touchmove", this._onGalleryTouchMove);
    const container = document.getElementById("gallery-image-container");
    if (this._onGalleryTouchEnd) {
      container?.removeEventListener("touchend", this._onGalleryTouchEnd);
      container?.removeEventListener("touchcancel", this._onGalleryTouchEnd);
    }
    if (this._onGalleryDblClick) container?.removeEventListener("dblclick", this._onGalleryDblClick);
    if (this._onGalleryGesture) {
      container?.removeEventListener("gesturestart", this._onGalleryGesture);
      container?.removeEventListener("gesturechange", this._onGalleryGesture);
    }
    if (this._onGalleryOverlayClick) document.getElementById("gallery-lightbox")?.removeEventListener("click", this._onGalleryOverlayClick);
  },

  /* ── Tap-to-zoom on the main working images ─────────────────────────────── */

  // Character Gen's portrait and the Playground's working image both open the
  // lightbox when tapped. Listeners sit on the containers rather than the
  // images, because a dozen code paths replace those images via innerHTML.
  _initImageZoomTriggers() {
    document.getElementById("image-content")?.addEventListener("click", (e) => {
      const img = e.target.closest("img");
      if (!img || !img.getAttribute("src")) return;
      const label = this.currentCharacter?.name || "";
      this.openGallery([{ url: img.getAttribute("src"), label }], 0, "view");
    });

    // Playground opens on the working image with every history version a
    // swipe away, so before/after an edit can be compared at full size.
    document.getElementById("playground-image-preview")?.addEventListener("click", (e) => {
      const img = e.target.closest("img");
      const current = img?.getAttribute("src");
      if (!current) return;
      const images = (this.playgroundHistory || []).map((entry) => ({
        url: entry.url,
        label: entry.label || "",
        prompt: entry.meta?.prompt || "",
      }));
      let start = images.findIndex((entry) => entry.url === current);
      if (start < 0) {
        images.unshift({ url: current, label: "" });
        start = 0;
      }
      this.openGallery(images, start, "playgroundHistory");
    });
  },

  /* ── Character image gallery (persisted, linked to a saved card) ─────────── */

  // Fetches a card's saved gallery images and appends the auth token each is
  // served with (these end up as <img src>/lightbox urls, which can't carry
  // an Authorization header — same reason getAvatarUrl does this for the
  // portrait thumbnail).
  async _loadCharacterGallery(cardId) {
    if (!cardId || !window.characterStorage) return [];
    try {
      const rows = await window.characterStorage.listGalleryImages(cardId);
      const token = window.cardgenAuth?.getToken() || localStorage.getItem("cardgen_auth_token") || "";
      return rows.map((row) => ({
        id: row.id,
        url: `${row.url}?token=${encodeURIComponent(token)}`,
      }));
    } catch (e) {
      console.error("Failed to load character gallery:", e);
      return [];
    }
  },

  // Opens the lightbox on a character's portrait plus its saved gallery
  // images, in order. avatarUrl is whatever the caller already resolved
  // (e.g. via getAvatarUrl) — if cardId can't be resolved or the gallery
  // fetch comes back empty, this just shows the portrait, matching the
  // previous single-image behavior.
  async openCardImageGallery(cardId, avatarUrl, label) {
    if (!avatarUrl) return;
    const images = [{ url: avatarUrl, label: label || "Portrait" }];
    if (cardId) {
      const galleryImages = await this._loadCharacterGallery(cardId);
      galleryImages.forEach((g) => images.push({ url: g.url, label: label || "Gallery" }));
    }
    this.openGallery(images, 0);
  },

  /* ── Helper: make an image list openable in the gallery ────────────────── */
  // Call this from image-handler to attach gallery triggers to image cards.
  // context is forwarded to openGallery() — see its comment for why ('card'
  // vs 'reference' changes what the gallery's own "Use This" button does).
  _makeImageGalleryable(gridContainer, images, context = 'card') {
    if (!gridContainer || !images || images.length === 0) return;

    const cards = gridContainer.querySelectorAll("[data-gallery-image]");
    // Already tagged — skip
    if (cards.length > 0) return;

    // Find all direct child image wrappers (divs containing <img>)
    const wrappers = gridContainer.querySelectorAll(":scope > div");
    let imageIndex = 0; // separate counter so skipped wrappers don't shift indexes
    wrappers.forEach((wrapper) => {
      // Skip the "CURRENT" keep-card — it is not in the images[] array
      if (wrapper.querySelector('[style*="CURRENT"]')) return;

      if (imageIndex >= images.length) return;

      // Already has gallery trigger?
      if (wrapper.dataset.galleryImage === "true") return;
      wrapper.dataset.galleryImage = "true";

      const capturedIndex = imageIndex;
      imageIndex++;

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
        this.openGallery(images, capturedIndex, context);
      });
      wrapper.appendChild(zoomBtn);
    });
  },

});
